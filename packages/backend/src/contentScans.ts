import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Content discovery keeps one ContentScan per existing file (see
 * agent/src/contentDiscovery.ts). These keep that set in step with the share: a file
 * deleted takes its result — and its matches — with it, a rename moves it,
 * and deleting a share removes all of them. Matches are current state here,
 * not history: a sensitive file that's gone shouldn't still count on Data Risk.
 */
export async function removeContentScans(db: Db, where: Prisma.ContentScanWhereInput): Promise<number> {
  const scans = await db.contentScan.findMany({ where, select: { id: true } });
  if (scans.length === 0) return 0;
  const ids = scans.map((s) => s.id);
  const jobFilter = { contentScanId: { in: ids } };
  await db.classificationMatch.deleteMany({ where: { classificationJob: jobFilter } });
  await db.classificationJob.deleteMany({ where: jobFilter });
  return (await db.contentScan.deleteMany({ where: { id: { in: ids } } })).count;
}

/** After a scan reports file changes: follow deletes and renames. */
export async function followFileEvents(
  sourceId: string,
  events: readonly { eventType: string; path: string; previousPath?: string | null }[],
): Promise<void> {
  const deleted = events.filter((e) => e.eventType === "DELETED").map((e) => e.path);
  if (deleted.length) await removeContentScans(prisma, { sourceId, path: { in: deleted } });
  for (const e of events) {
    if (e.eventType !== "RENAMED" || !e.previousPath) continue;
    // A file already examined under its new name keeps that result.
    if (await prisma.contentScan.findUnique({ where: { sourceId_path: { sourceId, path: e.path } } })) {
      await removeContentScans(prisma, { sourceId, path: e.previousPath });
      continue;
    }
    await prisma.contentScan.updateMany({ where: { sourceId, path: e.previousPath }, data: { path: e.path } });
    await prisma.classificationMatch.updateMany({
      where: { sourceId, path: e.previousPath, classificationJob: { contentScanId: { not: null } } },
      data: { path: e.path },
    });
  }
}
