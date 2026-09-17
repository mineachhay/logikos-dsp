import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivityCollectorConfig } from "@logikos-dsp/shared";
import { config } from "./config.js";
import { postActivity } from "./client.js";
import { buildActivityRecords, describeActivityError, initialBookmark, nextBookmark } from "./activityRecords.js";

/**
 * "Who changed this file": polls each Windows file server's Security log over
 * WinRM (see winrm/collect.py) and posts what it finds to /ingest/activity,
 * where it's matched onto the file events the share scans reported.
 *
 * One poll per server at a time; a server that's slow or unreachable can't
 * hold up the others, and its error is reported so the dashboard can show it.
 */

interface CollectorResult {
  events: string[];
  newestRecordId: number | null;
  windowEnd: number;
  error: string | null;
}

// See the agent Dockerfile: OpenSSL 3 hides MD4, which NTLM needs.
const OPENSSL_CONF = process.env.ACTIVITY_OPENSSL_CONF ?? "/etc/ssl/openssl-legacy.cnf";

const SCRIPT_PATH =
  process.env.ACTIVITY_COLLECTOR_SCRIPT ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "winrm", "collect.py");

const inFlight = new Set<string>();
/** Bookmarks the backend hasn't stored yet (first poll of a server, or a failed post). */
const localBookmarks = new Map<string, number>();

function runCollector(input: object): Promise<CollectorResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SCRIPT_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: existsSync(OPENSSL_CONF) ? { ...process.env, OPENSSL_CONF } : process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), config.activityTimeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`python3 collector: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        reject(new Error(stderr.trim() || `collector exited ${code} without output`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as CollectorResult);
      } catch {
        reject(new Error(`collector returned unparseable output: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function pollServer(collector: ActivityCollectorConfig): Promise<void> {
  if (inFlight.has(collector.fileServerId)) return;
  inFlight.add(collector.fileServerId);
  try {
    // The backend's bookmark wins; the local one covers the gap before the first successful post.
    const after = collector.bookmark ?? localBookmarks.get(collector.fileServerId) ?? 0;
    const result = await runCollector({
      host: collector.host,
      port: collector.winrmPort,
      username: collector.username,
      password: collector.password,
      after,
      window: config.activityWindowSize,
    });

    if (result.error) {
      await postActivity({
        fileServerId: collector.fileServerId,
        records: [],
        bookmark: after,
        error: describeActivityError(result.error, collector.host, collector.winrmPort),
      });
      return;
    }

    // First ever poll: don't replay the server's whole Security log.
    if (collector.bookmark === null && !localBookmarks.has(collector.fileServerId) && after === 0) {
      const start = initialBookmark(result.newestRecordId, config.activityWindowSize);
      localBookmarks.set(collector.fileServerId, start);
      await postActivity({ fileServerId: collector.fileServerId, records: [], bookmark: start });
      return;
    }

    const built = buildActivityRecords(result.events, collector.shares, {
      recordReads: collector.recordReads,
      scanAccount: collector.scanAccount,
    });
    const bookmark = nextBookmark({
      after,
      windowEnd: result.windowEnd,
      recordIds: built.recordIds,
      newestRecordId: result.newestRecordId,
    });
    localBookmarks.set(collector.fileServerId, bookmark);
    if (built.records.length > 0) {
      console.log(`activity: ${built.records.length} change(s) by user from ${collector.host} (${built.ignored} ignored)`);
    }
    await postActivity({ fileServerId: collector.fileServerId, records: built.records, bookmark });
  } catch (err) {
    await postActivity({
      fileServerId: collector.fileServerId,
      records: [],
      bookmark: collector.bookmark ?? 0,
      error: describeActivityError((err as Error).message, collector.host, collector.winrmPort),
    }).catch(() => undefined);
  } finally {
    inFlight.delete(collector.fileServerId);
  }
}

let warnedMissingScript = false;

/** Called from the managed-source sync with whatever /agent-sync last returned. */
export function collectActivity(collectors: readonly ActivityCollectorConfig[]): void {
  if (collectors.length === 0) return;
  if (!existsSync(SCRIPT_PATH)) {
    if (!warnedMissingScript) {
      console.error(`activity collection is on, but ${SCRIPT_PATH} is missing — is this an older agent image?`);
      warnedMissingScript = true;
    }
    return;
  }
  for (const collector of collectors) void pollServer(collector);
}
