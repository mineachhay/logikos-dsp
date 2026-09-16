import type { FileActivity, Prisma } from "@prisma/client";
import { activityWindowFor, inferRenameFromAudit, matchActivity, type ActivityCandidate } from "@logikos-dsp/shared";
import { prisma } from "./db.js";

/**
 * Joining "what changed" (SMB scans) to "who changed it" (Windows Security
 * events). The two arrive independently and in either order — a scan can
 * report a change before the audit poll fetches the record behind it, or
 * after — so matching runs from both sides: when file events are ingested,
 * and when activity is ingested. Matching itself is pure (packages/shared).
 */

function toCandidate(a: FileActivity): ActivityCandidate {
  return {
    id: a.id,
    path: a.path,
    action: a.action,
    occurredAt: a.occurredAt,
    userName: a.userName,
    userDomain: a.userDomain,
    clientIp: a.clientIp,
  };
}

function actorFields(match: ActivityCandidate): Prisma.FileEventUpdateInput {
  return {
    actorUser: match.userDomain ? `${match.userDomain}\\${match.userName}` : match.userName,
    actorIp: match.clientIp ?? null,
  };
}

/** Called when file events are ingested: is the audit record for them already here? */
export async function findActorForEvent(
  event: { sourceId: string; path: string; previousPath?: string | null; eventType: string; occurredAt: Date },
  scanIntervalSec: number,
): Promise<{ actorUser: string; actorIp: string | null } | null> {
  const window = activityWindowFor(scanIntervalSec);
  const candidates = await prisma.fileActivity.findMany({
    where: {
      sourceId: event.sourceId,
      // A rename is logged against the old name (see matchActivity).
      path: { in: event.previousPath ? [event.path, event.previousPath] : [event.path] },
      occurredAt: { gte: new Date(event.occurredAt.getTime() - window.beforeMs), lte: new Date(event.occurredAt.getTime() + window.afterMs) },
    },
    orderBy: { occurredAt: "desc" },
    take: 50,
  });
  const match = matchActivity(event, candidates.map(toCandidate), window);
  if (!match) return null;
  const fields = actorFields(match);
  return { actorUser: fields.actorUser as string, actorIp: (fields.actorIp as string) ?? null };
}

/**
 * Called when activity is ingested: fill in file events that were recorded
 * before their audit record arrived. Only events with no actor yet are
 * touched, so a later poll can't rewrite history.
 */
export async function backfillActorsForActivity(records: FileActivity[]): Promise<number> {
  let filled = 0;
  for (const record of records) {
    if (!record.sourceId || record.action === "READ" || record.action === "OTHER") continue;
    const source = await prisma.source.findUnique({ where: { id: record.sourceId }, select: { scanIntervalSec: true } });
    const window = activityWindowFor(source?.scanIntervalSec ?? 300);
    const events = await prisma.fileEvent.findMany({
      where: {
        sourceId: record.sourceId,
        // Either the file itself, or a rename away from this name.
        OR: [{ path: record.path }, { previousPath: record.path }],
        actorUser: null,
        occurredAt: { gte: new Date(record.occurredAt.getTime() - window.afterMs), lte: new Date(record.occurredAt.getTime() + window.beforeMs) },
      },
      orderBy: { occurredAt: "asc" },
      take: 20,
    });
    for (const event of events) {
      const match = matchActivity(event, [toCandidate(record)], window);
      if (!match) continue;
      await prisma.fileEvent.update({ where: { id: event.id }, data: actorFields(match) });
      filled++;
    }
  }
  return filled;
}

/**
 * Renames that happened between two scans, which scanning alone can't see: the
 * old name never appeared in a snapshot, so the file looks newly created.
 * Windows logged the rename as a delete of the old name — a delete with no
 * deletion of its own. Pairing the two turns a bare CREATED row into
 * "old → new" with the person who did it.
 *
 * Only unattributed creates are considered, and only when exactly one delete
 * fits (inferRenameFromAudit), so an ordinary create-and-delete pair in the
 * same minute is left alone rather than being called a rename.
 */
export async function linkBetweenScanRenames(sourceId: string, now = new Date()): Promise<number> {
  const source = await prisma.source.findUnique({ where: { id: sourceId }, select: { scanIntervalSec: true } });
  const window = activityWindowFor(source?.scanIntervalSec ?? 300);
  const since = new Date(now.getTime() - window.beforeMs - window.afterMs);

  const [creates, deleteRecords, deletedEvents] = await Promise.all([
    prisma.fileEvent.findMany({
      where: { sourceId, eventType: "CREATED", actorUser: null, previousPath: null, occurredAt: { gte: since } },
      orderBy: { occurredAt: "asc" },
    }),
    prisma.fileActivity.findMany({ where: { sourceId, action: "DELETE", occurredAt: { gte: since } } }),
    prisma.fileEvent.findMany({ where: { sourceId, eventType: "DELETED", occurredAt: { gte: since } }, select: { path: true } }),
  ]);
  if (creates.length === 0 || deleteRecords.length === 0) return 0;

  const used = new Set<string>();
  const reportedDeleted = deletedEvents.map((e) => e.path);
  let linked = 0;
  for (const create of creates) {
    const available = deleteRecords.filter((r) => !used.has(r.id)).map(toCandidate);
    const match = inferRenameFromAudit(create, available, reportedDeleted, window);
    if (!match) continue;
    used.add(match.id);
    await prisma.fileEvent.update({
      where: { id: create.id },
      data: { eventType: "RENAMED", previousPath: match.path, ...actorFields(match) },
    });
    linked++;
  }
  return linked;
}
