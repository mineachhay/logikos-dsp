import { randomUUID } from "node:crypto";
import type pg from "pg";
import { dueSlot, latestDailySlot, latestVerifySlot } from "@logikos-dsp/shared";

export interface SettingsRow {
  enabled: boolean;
  scheduleTimeUtc: string;
  scheduleActiveSince: Date | null;
  verifyWeekday: number | null;
  localRetention: number;
  remoteRetention: number;
  destinationType: "S3" | "SFTP" | "GDRIVE" | null;
  destinationConfig: unknown;
  credentialsEnc: string | null;
  remotePath: string;
  agePublicKey: string | null;
}

export interface RunRow {
  id: string;
  kind: "BACKUP" | "VERIFY" | "TEST_DESTINATION";
  trigger: "SCHEDULE" | "MANUAL";
}

export async function heartbeat(pool: pg.Pool): Promise<SettingsRow | null> {
  const { rows } = await pool.query(
    `INSERT INTO "BackupSettings" ("id", "workerHeartbeatAt", "updatedAt") VALUES ('default', now(), now())
     ON CONFLICT ("id") DO UPDATE SET "workerHeartbeatAt" = now()
     RETURNING *`,
  );
  return (rows[0] as SettingsRow) ?? null;
}

/** A run left RUNNING by a worker that died is failed on the next start, not left spinning forever. */
export async function failAbandonedRuns(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE "BackupRun" SET "status" = 'FAILED', "finishedAt" = now(), "message" = 'the backup worker stopped while this was running'
     WHERE "status" = 'RUNNING'`,
  );
  return rowCount ?? 0;
}

/** Inserts the due scheduled runs; the (kind, scheduledFor) unique index makes this safe to race. */
export async function enqueueDueRuns(pool: pg.Pool, s: SettingsRow, now = new Date()): Promise<void> {
  if (!s.enabled) return;
  const candidates: { kind: RunRow["kind"]; latest: Date }[] = [{ kind: "BACKUP", latest: latestDailySlot(now, s.scheduleTimeUtc) }];
  if (s.verifyWeekday !== null) candidates.push({ kind: "VERIFY", latest: latestVerifySlot(now, s.scheduleTimeUtc, s.verifyWeekday) });

  for (const { kind, latest } of candidates) {
    const { rows } = await pool.query(
      `SELECT max("scheduledFor") AS last FROM "BackupRun" WHERE "kind" = $1 AND "trigger" = 'SCHEDULE'`,
      [kind],
    );
    const slot = dueSlot({ now, latestSlot: latest, activeSince: s.scheduleActiveSince, lastRunSlot: rows[0]?.last ?? null });
    if (slot) {
      await pool.query(
        `INSERT INTO "BackupRun" ("id", "kind", "trigger", "scheduledFor") VALUES ($1, $2, 'SCHEDULE', $3)
         ON CONFLICT ("kind", "scheduledFor") DO NOTHING`,
        [randomUUID(), kind, slot],
      );
    }
  }
}

export async function claimRun(pool: pg.Pool): Promise<RunRow | null> {
  const { rows } = await pool.query(
    `UPDATE "BackupRun" SET "status" = 'RUNNING', "startedAt" = now()
     WHERE "id" = (SELECT "id" FROM "BackupRun" WHERE "status" = 'PENDING' ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING "id", "kind", "trigger"`,
  );
  return (rows[0] as RunRow) ?? null;
}

export async function finishRun(
  pool: pg.Pool,
  id: string,
  outcome: { ok: boolean; message: string; fileName?: string; sizeBytes?: number; sha256?: string },
): Promise<void> {
  await pool.query(
    `UPDATE "BackupRun" SET "status" = $2, "finishedAt" = now(), "message" = $3, "fileName" = $4, "sizeBytes" = $5, "sha256" = $6, "uploaded" = $7
     WHERE "id" = $1`,
    [id, outcome.ok ? "SUCCEEDED" : "FAILED", outcome.message, outcome.fileName ?? null, outcome.sizeBytes ?? null, outcome.sha256 ?? null, Boolean(outcome.ok && outcome.fileName)],
  );
}

export async function lastUpload(pool: pg.Pool): Promise<{ fileName: string; sizeBytes: number } | null> {
  const { rows } = await pool.query(
    `SELECT "fileName", "sizeBytes" FROM "BackupRun" WHERE "kind" = 'BACKUP' AND "status" = 'SUCCEEDED' AND "uploaded" ORDER BY "finishedAt" DESC LIMIT 1`,
  );
  return rows[0] ? { fileName: rows[0].fileName, sizeBytes: Number(rows[0].sizeBytes) } : null;
}

/**
 * A failed backup or restore check becomes a HIGH alert with a suggested
 * notification — the same approve-first path as every other alert, so it
 * shows in Alerts and can go to Telegram. Destination tests don't alert: an
 * admin just clicked the button and is looking at the result.
 */
export async function raiseFailureAlert(pool: pg.Pool, run: RunRow, message: string): Promise<void> {
  const alertId = randomUUID();
  const what = run.kind === "BACKUP" ? "Backup" : "Restore check";
  await pool.query(
    `INSERT INTO "Alert" ("id", "type", "severity", "status", "message", "metadata", "createdAt", "updatedAt")
     VALUES ($1, 'BACKUP_FAILED', 'HIGH', 'OPEN', $2, $3, now(), now())`,
    [alertId, `${what} failed (${run.trigger.toLowerCase()}): ${message}`.slice(0, 1000), JSON.stringify({ backupRunId: run.id, kind: run.kind })],
  );
  await pool.query(
    `INSERT INTO "ResponseAction" ("id", "alertId", "type", "status", "createdAt") VALUES ($1, $2, 'WEBHOOK_NOTIFICATION', 'PENDING', now())`,
    [randomUUID(), alertId],
  );
}
