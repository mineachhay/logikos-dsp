import { decryptSecret } from "@logikos-dsp/shared/credentials";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { shortMessage } from "./pure.js";
import type { DestinationInput } from "./rcloneConfig.js";
import { claimRun, enqueueDueRuns, failAbandonedRuns, finishRun, heartbeat, lastUpload, raiseFailureAlert, type RunRow, type SettingsRow } from "./runs.js";
import { runBackup, runRestoreCheck, testDestination } from "./steps.js";

/**
 * Off-box backup worker. Polls the database: heartbeats (the dashboard shows
 * whether it's alive), enqueues scheduled runs, and executes pending runs one
 * at a time. Configuration is whatever Administration -> Backups last saved.
 */

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);

function destinationFrom(s: SettingsRow): DestinationInput | null {
  if (!s.destinationType || !s.credentialsEnc) return null;
  return {
    type: s.destinationType,
    config: s.destinationConfig,
    credentials: JSON.parse(decryptSecret(s.credentialsEnc, cfg.credentialsKey)),
    remotePath: s.remotePath,
  };
}

async function execute(run: RunRow, s: SettingsRow): Promise<void> {
  const destination = destinationFrom(s);
  console.log(`running ${run.trigger.toLowerCase()} ${run.kind} ${run.id}`);
  try {
    if (run.kind === "TEST_DESTINATION") {
      if (!destination) throw new Error("no destination saved");
      await finishRun(pool, run.id, { ok: true, message: await testDestination(destination) });
    } else if (run.kind === "BACKUP") {
      if (!destination) throw new Error("no destination saved");
      if (!s.agePublicKey) throw new Error("no age public key saved — refusing to upload an unencrypted backup");
      const result = await runBackup(cfg, destination, s.agePublicKey, { local: s.localRetention, remote: s.remoteRetention });
      await finishRun(pool, run.id, { ok: true, ...result });
    } else {
      const message = await runRestoreCheck(cfg, destination, await lastUpload(pool));
      await finishRun(pool, run.id, { ok: true, message });
    }
    console.log(`${run.kind} ${run.id} succeeded`);
  } catch (err) {
    const message = shortMessage((err as Error).message);
    console.error(`${run.kind} ${run.id} failed: ${message}`);
    await finishRun(pool, run.id, { ok: false, message });
    if (run.kind !== "TEST_DESTINATION") await raiseFailureAlert(pool, run, message);
  }
}

async function tick(): Promise<void> {
  const settings = await heartbeat(pool);
  if (!settings) return;
  await enqueueDueRuns(pool, settings);
  // Drain the queue, re-reading settings per run so a change saved mid-queue applies.
  for (let run = await claimRun(pool); run; run = await claimRun(pool)) {
    const current = (await heartbeat(pool)) ?? settings;
    // Keep heartbeating while a long dump or upload runs, or the dashboard
    // would report the worker offline in the middle of a backup.
    const beat = setInterval(() => heartbeat(pool).catch(() => undefined), 30_000);
    try {
      await execute(run, current);
    } finally {
      clearInterval(beat);
    }
  }
}

async function main(): Promise<void> {
  const abandoned = await failAbandonedRuns(pool);
  if (abandoned) console.warn(`marked ${abandoned} run(s) left RUNNING by a previous worker as failed`);
  console.log(`backup worker started, polling every ${cfg.pollIntervalMs}ms, dumps in ${cfg.backupDir}`);
  for (;;) {
    await tick().catch((err) => console.error("backup worker tick failed", err));
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error("backup worker failed to start", err);
  process.exit(1);
});
