import type { FileEventInput, FileEventType } from "@logikos-dsp/shared";
import type { Source } from "./sources/types.js";
import { config } from "./config.js";
import { postEvents, postStorageSnapshot } from "./client.js";
import { isSampleable } from "./contentSampling.js";
import { diffSnapshots } from "./diff.js";
import type { Baseline } from "./diff.js";

export interface DiffLoopOptions {
  /** Set for dashboard-managed shares; omitted for the agent's own env-configured source. */
  sourceId?: string;
  /** Wraps each walk, e.g. managedSources.ts's concurrency limiter. */
  runScan?: <T>(scan: () => Promise<T>) => Promise<T>;
  onScanComplete?: (result: { ok: true; fileCount: number; totalBytes: number } | { ok: false; error: unknown }) => void;
}

export interface DiffLoop {
  stop(): void;
  setInterval(intervalMs: number): void;
}

async function buildEvent(
  source: Source,
  sourceId: string | undefined,
  eventType: FileEventType,
  path: string,
  stats: Baseline,
): Promise<FileEventInput> {
  let contentSample: string | undefined;
  if (isSampleable(path, stats.sizeBytes)) {
    const buf = await source.readSample(path, config.maxContentSampleBytes);
    contentSample = buf?.toString("base64");
  }
  return {
    agentKey: config.agentKey,
    sourceId,
    eventType,
    path,
    sizeBytes: stats.sizeBytes,
    occurredAt: new Date().toISOString(),
    contentSample,
  };
}

/**
 * Walks `source`, diffs against the previous walk's baseline, and reports
 * created/modified/deleted FileEvents plus a StorageSnapshot — one remote
 * walk serves both, unlike local mode where chokidar (real-time) and the
 * periodic storage scan run independently. Like chokidar's ignoreInitial,
 * the very first walk seeds the baseline without emitting events, so an
 * agent restart doesn't replay the share's entire existing contents as
 * "created". `isStopped` is checked after the walk so a share removed
 * mid-scan doesn't post into a source the backend no longer has.
 */
async function scanOnce(
  source: Source,
  baseline: Map<string, Baseline> | null,
  sourceId: string | undefined,
  isStopped: () => boolean,
  previousScanAt: number | undefined,
): Promise<{ baseline: Map<string, Baseline>; fileCount: number; totalBytes: number } | null> {
  const nodes = await source.listTree();
  if (isStopped()) return null;
  const current = new Map<string, Baseline>();
  for (const node of nodes) {
    current.set(node.path, { sizeBytes: node.sizeBytes, mtimeMs: node.mtimeMs });
  }

  if (baseline !== null) {
    const diff = diffSnapshots(baseline, current, previousScanAt);
    const events: FileEventInput[] = [];

    for (const path of diff.created) {
      events.push(await buildEvent(source, sourceId, "created", path, current.get(path)!));
    }
    for (const path of diff.modified) {
      events.push(await buildEvent(source, sourceId, "modified", path, current.get(path)!));
    }
    for (const copy of diff.copied) {
      // Same contents as the file it came from, which has already been
      // classified — no need to sample and re-scan it.
      events.push({
        agentKey: config.agentKey,
        sourceId,
        eventType: "copied",
        path: copy.to,
        previousPath: copy.from ?? undefined,
        sizeBytes: copy.sizeBytes,
        occurredAt: new Date().toISOString(),
      });
    }
    for (const rename of diff.renamed) {
      // Contents didn't change, so no new content sample: the file was already
      // classified when it was created or last modified.
      events.push({
        agentKey: config.agentKey,
        sourceId,
        eventType: "renamed",
        path: rename.to,
        previousPath: rename.from,
        sizeBytes: rename.sizeBytes,
        occurredAt: new Date().toISOString(),
      });
    }
    for (const path of diff.deleted) {
      events.push({
        agentKey: config.agentKey,
        sourceId,
        eventType: "deleted",
        path,
        occurredAt: new Date().toISOString(),
      });
    }

    for (let i = 0; i < events.length; i += config.eventBatchSize) {
      await postEvents(events.slice(i, i + config.eventBatchSize));
    }
    if (events.length > 0) {
      console.log(`${source.describe()}: ${events.length} file event(s)`);
    }
  }

  const totalBytes = nodes.reduce((sum, n) => sum + n.sizeBytes, 0);
  await postStorageSnapshot({
    agentKey: config.agentKey,
    sourceId,
    rootPath: source.describe(),
    totalBytes,
    fileCount: nodes.length,
    takenAt: new Date().toISOString(),
  });
  console.log(`${source.describe()}: storage snapshot ${nodes.length} files, ${totalBytes} bytes`);

  return { baseline: current, fileCount: nodes.length, totalBytes };
}

/**
 * Scans now, then `intervalMs` after each scan *finishes* — a setTimeout
 * chain rather than setInterval, so a walk that takes longer than the
 * interval (a large share) never overlaps itself.
 */
export function startDiffLoop(source: Source, intervalMs: number, opts: DiffLoopOptions = {}): DiffLoop {
  let baseline: Map<string, Baseline> | null = null;
  let previousScanAt: number | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let interval = intervalMs;
  const runScan = opts.runScan ?? ((scan) => scan());

  async function tick() {
    try {
      const startedAt = Date.now();
      const result = await runScan(() => scanOnce(source, baseline, opts.sourceId, () => stopped, previousScanAt));
      if (result) {
        baseline = result.baseline;
        previousScanAt = startedAt;
        opts.onScanComplete?.({ ok: true, fileCount: result.fileCount, totalBytes: result.totalBytes });
      }
    } catch (err) {
      console.error(`${source.describe()}: snapshot scan failed`, err);
      if (!stopped) opts.onScanComplete?.({ ok: false, error: err });
    } finally {
      if (!stopped) timer = setTimeout(tick, interval);
    }
  }

  console.log(`watching ${source.describe()} via periodic snapshot diff (every ${intervalMs}ms)`);
  void tick();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    setInterval(ms: number) {
      interval = ms;
    },
  };
}

/** The agent's own env-configured source (SOURCE_TYPE=smb/m365/gdrive). */
export function runDiffLoop(source: Source, intervalMs: number): void {
  startDiffLoop(source, intervalMs);
}
