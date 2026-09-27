import type { PrismaClient } from "@prisma/client";
import { prisma } from "./db.js";

/**
 * Deleting collected data once it's older than the configured age. Nothing is
 * deleted unless an ADMIN turns this on: an install shouldn't quietly start
 * dropping its own audit trail.
 *
 * Deletes run in bounded batches rather than one statement per table, so a
 * first sweep over a long-neglected database can't hold locks for minutes or
 * blow up a transaction; whatever is left is picked up by the next pass.
 */

export const BATCH_SIZE = 5_000;
/** Ceiling per table per pass, so one sweep can't run for hours. */
export const MAX_BATCHES = 20;

export interface RetentionCutoffs {
  fileEvents: Date;
  fileActivity: Date;
  storageSnapshots: Date;
  resolvedAlerts: Date;
  loginAttempts: Date;
}

export interface RetentionSettingsLike {
  fileEventDays: number;
  fileActivityDays: number;
  storageSnapshotDays: number;
  resolvedAlertDays: number;
  loginAttemptDays: number;
}

const DAY_MS = 86_400_000;

export function cutoffsFor(settings: RetentionSettingsLike, now: Date): RetentionCutoffs {
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
  return {
    fileEvents: at(settings.fileEventDays),
    fileActivity: at(settings.fileActivityDays),
    storageSnapshots: at(settings.storageSnapshotDays),
    resolvedAlerts: at(settings.resolvedAlertDays),
    loginAttempts: at(settings.loginAttemptDays),
  };
}

export interface RetentionResult {
  fileEvents: number;
  classificationMatches: number;
  fileActivity: number;
  storageSnapshots: number;
  alerts: number;
  loginAttempts: number;
}

export function summarize(result: RetentionResult): string {
  const parts = Object.entries(result)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${count} ${table.replace(/([A-Z])/g, " $1").toLowerCase()}`);
  return parts.length ? `deleted ${parts.join(", ")}` : "nothing to delete";
}

/**
 * File events own their classification results (job → matches), so those go
 * first; the FKs are RESTRICT, which is what stops a half-deleted event.
 */
async function deleteOldFileEvents(db: PrismaClient, cutoff: Date): Promise<{ events: number; matches: number }> {
  let events = 0;
  let matches = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const ids = (
      await db.fileEvent.findMany({ where: { occurredAt: { lt: cutoff } }, select: { id: true }, take: BATCH_SIZE })
    ).map((e) => e.id);
    if (ids.length === 0) break;
    const jobFilter = { fileEvent: { id: { in: ids } } };
    matches += (await db.classificationMatch.deleteMany({ where: { classificationJob: jobFilter } })).count;
    await db.classificationJob.deleteMany({ where: jobFilter });
    events += (await db.fileEvent.deleteMany({ where: { id: { in: ids } } })).count;
  }
  return { events, matches };
}

/**
 * Storage history thins out, but every source keeps its most recent snapshot
 * however old it is — otherwise a share that stopped changing would vanish
 * from the Storage view entirely.
 */
async function deleteOldSnapshots(db: PrismaClient, cutoff: Date): Promise<number> {
  const newest = await db.storageSnapshot.groupBy({ by: ["sourceId"], _max: { takenAt: true } });
  const keep = newest.map((n) => n._max.takenAt!).filter(Boolean);
  const result = await db.storageSnapshot.deleteMany({
    where: { takenAt: { lt: cutoff, notIn: keep } },
  });
  return result.count;
}

async function deleteOldAlerts(db: PrismaClient, cutoff: Date): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const ids = (
      await db.alert.findMany({
        // Only resolved ones: an open or acknowledged alert is still someone's to-do.
        where: { status: "RESOLVED", createdAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      })
    ).map((a) => a.id);
    if (ids.length === 0) break;
    await db.responseAction.deleteMany({ where: { alertId: { in: ids } } });
    deleted += (await db.alert.deleteMany({ where: { id: { in: ids } } })).count;
  }
  return deleted;
}

/** One sweep. Returns what it deleted, or null when retention is off. */
export async function runRetention(db: PrismaClient = prisma, now = new Date()): Promise<RetentionResult | null> {
  const settings = await db.retentionSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  if (!settings.enabled) return null;

  const cutoffs = cutoffsFor(settings, now);
  const { events, matches } = await deleteOldFileEvents(db, cutoffs.fileEvents);
  const result: RetentionResult = {
    fileEvents: events,
    classificationMatches: matches,
    fileActivity: (await db.fileActivity.deleteMany({ where: { occurredAt: { lt: cutoffs.fileActivity } } })).count,
    storageSnapshots: await deleteOldSnapshots(db, cutoffs.storageSnapshots),
    alerts: await deleteOldAlerts(db, cutoffs.resolvedAlerts),
    loginAttempts: (await db.loginAttempt.deleteMany({ where: { at: { lt: cutoffs.loginAttempts } } })).count,
  };

  await db.retentionSettings.update({
    where: { id: "default" },
    data: { lastRunAt: new Date(), lastRunSummary: summarize(result) },
  });
  return result;
}

/**
 * Settings → Monitoring defaults → thin out old storage snapshots. Scans take
 * one a minute per source, which no one needs at that grain for long: after a
 * day only the newest per hour is kept, after 30 days the newest per day. The
 * newest snapshot of each source is always inside its own bucket, so it stays.
 * Independent of retention (which deletes by age) and on by default, since it
 * only removes near-duplicates.
 */
export async function thinSnapshots(db: PrismaClient = prisma, now = new Date()): Promise<number> {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  // The bucket is computed once and named: DISTINCT ON must match ORDER BY
  // exactly, and two copies of the expression get different parameter numbers.
  return db.$executeRaw`
    DELETE FROM "StorageSnapshot"
    WHERE "takenAt" < ${dayAgo}
      AND "id" NOT IN (
        SELECT DISTINCT ON (grp, bucket) id
        FROM (
          SELECT "id" AS id, COALESCE("sourceId", "agentId") AS grp, "takenAt" AS taken,
                 date_trunc(CASE WHEN "takenAt" < ${monthAgo} THEN 'day' ELSE 'hour' END, "takenAt") AS bucket
          FROM "StorageSnapshot"
        ) k
        ORDER BY grp, bucket, taken DESC
      )`;
}
