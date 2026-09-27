import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { findSensitivePatterns } from "./patterns.js";
import { findNamedEntities, preloadNerModel } from "./ner.js";
import { supportsQuarantine } from "@logikos-dsp/shared";

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

/**
 * Discovery examines files that were already there, so its findings aren't
 * "something just happened" — and a first pass over a share could otherwise
 * raise hundreds of alerts (with a notification each) at once, burying
 * everything else. Instead one open alert per source says how many existing
 * files hold sensitive data, updated as the pass goes; the files themselves
 * are on Data Risk. MEDIUM, so no response actions are attached (those are
 * for HIGH/CRITICAL, per-file alerts).
 */
async function noteDiscoveryFinding(sourceId: string, sourceRoot: string, agentId: string | null): Promise<void> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT c."id")::int AS files
     FROM "ContentScan" c JOIN "ClassificationJob" j ON j."contentScanId" = c."id"
     WHERE c."sourceId" = $1 AND EXISTS (SELECT 1 FROM "ClassificationMatch" m WHERE m."classificationJobId" = j."id")`,
    [sourceId],
  );
  const files = rows[0]?.files ?? 0;
  const message = `Content discovery found sensitive data in ${files} existing file${files === 1 ? "" : "s"} on ${sourceRoot} — see Data Risk.`;
  const updated = await pool.query(
    `UPDATE "Alert" SET "message" = $2, "metadata" = jsonb_set(COALESCE("metadata", '{}'::jsonb), '{files}', to_jsonb($3::int)), "updatedAt" = now()
     WHERE "sourceId" = $1 AND "type" = 'SENSITIVE_DATA_EXPOSED' AND "status" <> 'RESOLVED' AND "metadata"->>'discovery' = 'true'`,
    [sourceId, message, files],
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO "Alert" ("id","type","severity","status","agentId","sourceId","message","metadata","createdAt","updatedAt")
       VALUES ($1,'SENSITIVE_DATA_EXPOSED','MEDIUM','OPEN',$2,$3,$4,$5,now(),now())`,
      [randomUUID(), agentId, sourceId, message, JSON.stringify({ discovery: true, files })],
    );
  }
}

async function processJob(jobId: string): Promise<void> {
  // A job classifies a changed file's sample (FileEvent) or an existing
  // file's, found by content discovery (ContentScan) — exactly one is set.
  const { rows } = await pool.query(
    `SELECT COALESCE(e."path", c."path") AS path,
            COALESCE(e."contentSample", c."contentSample") AS content_sample,
            COALESCE(e."agentId", c."agentId") AS agent_id,
            s."id" AS source_id,
            s."rootLabel" AS source_root,
            (j."contentScanId" IS NOT NULL) AS discovery
     FROM "ClassificationJob" j
     LEFT JOIN "FileEvent" e ON e."id" = j."fileEventId"
     LEFT JOIN "ContentScan" c ON c."id" = j."contentScanId"
     JOIN "Source" s ON s."id" = COALESCE(e."sourceId", c."sourceId")
     WHERE j."id" = $1`,
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
           ("id","classificationJobId","patternType","redactedSample","path","sourceId","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [randomUUID(), jobId, PATTERN_TYPE_MAP[match.patternType], match.redactedSample, row.path, row.source_id],
      );
    }

    if (matches.length > 0 && row.discovery) {
      await noteDiscoveryFinding(row.source_id, row.source_root, row.agent_id);
    } else if (matches.length > 0) {
      const severity = matches.some((m) => m.patternType === "ssn" || m.patternType === "credit_card")
        ? "HIGH"
        : "MEDIUM";
      const alertId = randomUUID();
      await pool.query(
        `INSERT INTO "Alert"
           ("id","type","severity","status","agentId","sourceId","message","metadata","createdAt","updatedAt")
         VALUES ($1,'SENSITIVE_DATA_EXPOSED',$2,'OPEN',$3,$4,$5,$6,now(),now())`,
        [
          alertId,
          severity,
          row.agent_id,
          row.source_id,
          `Sensitive data detected in ${row.path} on ${row.source_root}: ${matches.map((m) => m.patternType).join(", ")}`,
          JSON.stringify({ path: row.path, patternTypes: matches.map((m) => m.patternType) }),
        ],
      );

      // HIGH alerts get suggested response actions, but nothing fires until
      // an ADMIN approves it via POST /response-actions/:id/approve — see
      // ARCHITECTURE.md's "approve-first, always" note. Quarantine is
      // suggested for local-path and SMB agents (both can write); M365 and
      // Google Drive stay excluded (read-only OAuth scopes) — see
      // watchedRoot.ts's supportsQuarantine.
      if (severity === "HIGH") {
        await pool.query(
          `INSERT INTO "ResponseAction" ("id","alertId","type","status","createdAt")
           VALUES ($1,$2,'WEBHOOK_NOTIFICATION','PENDING',now())`,
          [randomUUID(), alertId],
        );

        if (supportsQuarantine(row.source_root as string)) {
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
