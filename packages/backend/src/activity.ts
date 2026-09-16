import type { FileActivity, Prisma } from "@prisma/client";
import { activityWindowFor, matchActivity, type ActivityCandidate } from "@logikos-dsp/shared";
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
  event: { sourceId: string; path: string; eventType: string; occurredAt: Date },
  scanIntervalSec: number,
): Promise<{ actorUser: string; actorIp: string | null } | null> {
  const window = activityWindowFor(scanIntervalSec);
  const candidates = await prisma.fileActivity.findMany({
    where: {
      sourceId: event.sourceId,
      path: event.path,
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
        path: record.path,
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
