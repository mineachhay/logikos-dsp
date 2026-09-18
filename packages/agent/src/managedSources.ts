import type { ManagedSmbSource, PendingConnectionTest, PendingDiscoveryScan } from "@logikos-dsp/shared";
import { config } from "./config.js";
import { completeConnectionTest, completeDiscoveryScan, fetchAgentSync, reportSourceStatus, startDiscoveryScan } from "./client.js";
import { runDiscoveryScan } from "./discovery.js";
import { runDeployments } from "./deployer.js";
import { collectActivity } from "./activityCollector.js";
import { forgetKnownFiles, setKnownFiles } from "./knownFiles.js";
import { SmbSource } from "./sources/smb.js";
import { startDiffLoop, type DiffLoop } from "./snapshotDiff.js";
import { connectionKey, createLimiter, describeSmbError, planReconcile, type RunningSource } from "./sourceReconcile.js";

/**
 * Dashboard-managed SMB shares. Polls GET /agent-sync, and reconciles one
 * snapshot-diff loop per assigned share against it (sourceReconcile.ts decides
 * what changes). Runs alongside whatever the agent's own env configures —
 * the local watcher in the bundled container.
 */

interface Running extends RunningSource {
  loop: DiffLoop;
  source: SmbSource;
}

const running = new Map<string, Running>();
const limiter = createLimiter(config.maxConcurrentScans);
const testsInFlight = new Set<string>();
const scansInFlight = new Set<string>();

function toSmbConfig(s: Pick<ManagedSmbSource, "host" | "port" | "domain" | "username" | "password" | "share" | "subPath">) {
  return {
    host: s.host,
    port: s.port,
    domain: s.domain,
    username: s.username,
    password: s.password,
    share: s.share,
    subPath: s.subPath || undefined,
  };
}

function start(spec: ManagedSmbSource): void {
  const source = new SmbSource(toSmbConfig(spec));
  const loop = startDiffLoop(source, spec.scanIntervalSec * 1000, {
    sourceId: spec.id,
    runScan: (scan) => limiter.run(scan),
    onScanComplete: (result) => {
      if (result.ok) setKnownFiles(spec.id, result.paths);
      const status = result.ok
        ? { ok: true as const, fileCount: result.fileCount, totalBytes: result.totalBytes }
        : { ok: false as const, error: describeSmbError(result.error) };
      reportSourceStatus(spec.id, status).catch((err) => console.error("status report failed", err));
    },
  });
  running.set(spec.id, { loop, source, connectionKey: connectionKey(spec), scanIntervalSec: spec.scanIntervalSec });
}

function stop(id: string): void {
  const entry = running.get(id);
  if (!entry) return;
  entry.loop.stop();
  try {
    entry.source.disconnect();
  } catch {
    // already disconnected
  }
  running.delete(id);
  forgetKnownFiles(id);
  console.log(`stopped managed source ${id}`);
}

async function runConnectionTest(test: PendingConnectionTest): Promise<void> {
  if (testsInFlight.has(test.id)) return;
  testsInFlight.add(test.id);
  const source = new SmbSource(toSmbConfig(test));
  try {
    const message = await source.testConnection();
    await completeConnectionTest(test.id, true, message);
  } catch (err) {
    await completeConnectionTest(test.id, false, describeSmbError(err));
  } finally {
    try {
      source.disconnect();
    } catch {
      // never connected
    }
    testsInFlight.delete(test.id);
  }
}

async function syncOnce(): Promise<void> {
  const sync = await fetchAgentSync();
  if (!sync) return; // transport or auth problem, already logged; keep what's running

  const plan = planReconcile(running, sync.sources);
  for (const id of plan.stop) stop(id);
  for (const spec of plan.start) start(spec);
  for (const spec of plan.retime) {
    const entry = running.get(spec.id)!;
    entry.loop.setInterval(spec.scanIntervalSec * 1000);
    entry.scanIntervalSec = spec.scanIntervalSec;
  }

  for (const test of sync.connectionTests) {
    void runConnectionTest(test);
  }

  // Windows servers with "who changed files" turned on. Each poll runs
  // independently; pollServer skips a server whose previous poll is still running.
  collectActivity(sync.activityCollectors ?? []);

  for (const scan of sync.discoveryScans ?? []) {
    void runScan(scan);
  }

  // Remote installs. The credentials came with the job and exist only for as
  // long as it runs.
  runDeployments(sync.deployments ?? []);
}

/**
 * Network sweeps requested from the dashboard. Deliberately fire-and-forget,
 * like a connection test: a /24 takes seconds, and the sync loop mustn't wait
 * for it — the agent's real work is watching files.
 */
async function runScan(scan: PendingDiscoveryScan): Promise<void> {
  if (scansInFlight.has(scan.id)) return;
  scansInFlight.add(scan.id);
  try {
    await startDiscoveryScan(scan.id);
    const hosts = await runDiscoveryScan(scan);
    console.log(`discovery scan ${scan.id}: ${hosts.length} machine(s) answered out of ${scan.addresses.length} addresses`);
    await completeDiscoveryScan(scan.id, { status: "SUCCEEDED", hosts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`discovery scan ${scan.id} failed`, err);
    await completeDiscoveryScan(scan.id, { status: "FAILED", message, hosts: [] });
  } finally {
    scansInFlight.delete(scan.id);
  }
}

export function startManagedSources(): void {
  console.log(`syncing dashboard-managed sources every ${config.agentSyncIntervalMs}ms (max ${config.maxConcurrentScans} concurrent scans)`);
  const tick = () => syncOnce().catch((err) => console.error("managed source sync failed", err));
  void tick();
  setInterval(tick, config.agentSyncIntervalMs);
}
