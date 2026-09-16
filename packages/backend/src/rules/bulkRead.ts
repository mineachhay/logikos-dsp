import { BULK_READ_THRESHOLD, BULK_READ_WINDOW_SECONDS } from "@logikos-dsp/shared";
import { prisma } from "../db.js";

/**
 * Copying files *off* a share changes nothing on it, so no scan can see it —
 * the only trace is one read per file in the Windows audit log. Reading many
 * distinct files in a short window, from one account, is what that looks like;
 * opening documents to work on them doesn't reach this rate.
 *
 * Counts distinct paths, not records: Windows logs several reads of the same
 * file, and re-reading one document all morning isn't an exfiltration.
 */
export async function checkBulkRead(sourceId: string, userName: string, now = new Date()): Promise<void> {
  const windowStart = new Date(now.getTime() - BULK_READ_WINDOW_SECONDS * 1000);

  const distinct = await prisma.fileActivity.findMany({
    where: { sourceId, userName, action: "READ", occurredAt: { gte: windowStart } },
    select: { path: true },
    distinct: ["path"],
    take: BULK_READ_THRESHOLD + 1,
  });
  if (distinct.length <= BULK_READ_THRESHOLD) return;

  // One alert per burst, not one per poll.
  const existing = await prisma.alert.findFirst({
    where: { sourceId, type: "BULK_FILE_READ", status: "OPEN", createdAt: { gte: windowStart } },
  });
  if (existing) return;

  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  const alert = await prisma.alert.create({
    data: {
      type: "BULK_FILE_READ",
      severity: "MEDIUM",
      agentId: source?.agentId,
      sourceId,
      message: `${userName} read ${distinct.length}+ different files on ${source?.rootLabel ?? "a share"} within ${BULK_READ_WINDOW_SECONDS / 60} minutes — possible bulk copy off the share.`,
      metadata: { userName, distinctFiles: distinct.length, windowSeconds: BULK_READ_WINDOW_SECONDS },
    },
  });
  // Suggested, not automatic — same approve-first path as every other alert.
  await prisma.responseAction.create({ data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" } });
}
