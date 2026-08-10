import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { findSensitivePatterns } from "./patterns.js";
import { findNamedEntities, preloadNerModel } from "./ner.js";
import { isLocalWatchedRoot } from "./watchedRoot.js";

const PATTERN_TYPE_MAP: Record<string, string> = {
  ssn: "SSN",
  credit_card: "CREDIT_CARD",
  email: "EMAIL",
  phone: "PHONE",
  person: "PERSON",
  organization: "ORGANIZATION",
  location: "LOCATION",
};

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const BATCH_SIZE = 20;

/** Claims up to BATCH_SIZE pending jobs via SELECT ... FOR UPDATE SKIP LOCKED,
 * so multiple worker instances can run concurrently without double-processing. */
async function claimPendingJobs(): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT "id" FROM "ClassificationJob"
       WHERE "status" = 'PENDING'
       ORDER BY "createdAt" ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE],
    );
    const ids = rows.map((r) => r.id as string);
    if (ids.length > 0) {
      await client.query(
        `UPDATE "ClassificationJob" SET "status" = 'PROCESSING' WHERE "id" = ANY($1::text[])`,
        [ids],
      );
    }
    await client.query("COMMIT");
    return ids;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function processJob(jobId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT "FileEvent"."path" AS path,
            "FileEvent"."contentSample" AS content_sample,
            "FileEvent"."agentId" AS agent_id,
            "Agent"."watchedRoot" AS agent_watched_root
     FROM "ClassificationJob"
     JOIN "FileEvent" ON "FileEvent"."id" = "ClassificationJob"."fileEventId"
     JOIN "Agent" ON "Agent"."id" = "FileEvent"."agentId"
     WHERE "ClassificationJob"."id" = $1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) {
    console.warn(`classification job ${jobId} has no linked file event, marking failed`);
    await pool.query(
      `UPDATE "ClassificationJob" SET "status"='FAILED', "processedAt"=now() WHERE "id"=$1`,
      [jobId],
    );
    return;
  }

  try {
    const content = row.content_sample
      ? Buffer.from(row.content_sample, "base64").toString("utf8")
      : "";
    const matches = [...findSensitivePatterns(content), ...(await findNamedEntities(content))];

    for (const match of matches) {
      await pool.query(
        `INSERT INTO "ClassificationMatch"
           ("id","classificationJobId","patternType","redactedSample","path","createdAt")
         VALUES ($1,$2,$3,$4,$5,now())`,
        [randomUUID(), jobId, PATTERN_TYPE_MAP[match.patternType], match.redactedSample, row.path],
      );
    }

    if (matches.length > 0) {
      const severity = matches.some((m) => m.patternType === "ssn" || m.patternType === "credit_card")
        ? "HIGH"
        : "MEDIUM";
      const alertId = randomUUID();
      await pool.query(
        `INSERT INTO "Alert"
           ("id","type","severity","status","agentId","message","metadata","createdAt","updatedAt")
         VALUES ($1,'SENSITIVE_DATA_EXPOSED',$2,'OPEN',$3,$4,$5,now(),now())`,
        [
          alertId,
          severity,
          row.agent_id,
          `Sensitive data detected in ${row.path}: ${matches.map((m) => m.patternType).join(", ")}`,
          JSON.stringify({ path: row.path, patternTypes: matches.map((m) => m.patternType) }),
        ],
      );

      // HIGH alerts get suggested response actions, but nothing fires until
      // an ADMIN approves it via POST /response-actions/:id/approve — see
      // ARCHITECTURE.md's "approve-first, always" note. Quarantine is only
      // ever suggested for local-path agents — every cloud/network connector
      // (SMB, M365, ...) registers a watchedRoot with a "scheme://" prefix
      // and is deliberately read-only; a bare filesystem path never contains
      // "://", so this generalizes cleanly to any future connector too.
      if (severity === "HIGH") {
        await pool.query(
          `INSERT INTO "ResponseAction" ("id","alertId","type","status","createdAt")
           VALUES ($1,$2,'WEBHOOK_NOTIFICATION','PENDING',now())`,
          [randomUUID(), alertId],
        );

        if (isLocalWatchedRoot(row.agent_watched_root as string)) {
          await pool.query(
            `INSERT INTO "ResponseAction" ("id","alertId","type","status","createdAt")
             VALUES ($1,$2,'FILE_QUARANTINE','PENDING',now())`,
            [randomUUID(), alertId],
          );
        }
      }
    }

    await pool.query(
      `UPDATE "ClassificationJob" SET "status"='DONE', "processedAt"=now() WHERE "id"=$1`,
      [jobId],
    );
  } catch (err) {
    console.error(`classification job ${jobId} failed`, err);
    await pool.query(
      `UPDATE "ClassificationJob" SET "status"='FAILED', "processedAt"=now() WHERE "id"=$1`,
      [jobId],
    );
  }
}

async function tick() {
  const ids = await claimPendingJobs();
  for (const id of ids) {
    await processJob(id);
  }
  if (ids.length > 0) {
    console.log(`processed ${ids.length} classification job(s)`);
  }
}

async function main() {
  console.log("classification worker starting, loading NER model...");
  await preloadNerModel();

  console.log(`classification worker started, polling every ${POLL_INTERVAL_MS}ms`);
  setInterval(() => {
    tick().catch((err) => console.error("classification tick failed", err));
  }, POLL_INTERVAL_MS);
  tick().catch((err) => console.error("classification tick failed", err));
}

main().catch((err) => {
  console.error("classification worker failed to start", err);
  process.exit(1);
});
