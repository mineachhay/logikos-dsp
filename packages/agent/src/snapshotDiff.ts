import type { FileEventInput, FileEventType } from "@logikos-dsp/shared";
import type { Source } from "./sources/types.js";
import { config } from "./config.js";
import { postEvents, postStorageSnapshot } from "./client.js";
import { isSampleable } from "./contentSampling.js";

interface Baseline {
  sizeBytes: number;
  mtimeMs: number;
}

async function buildEvent(
  source: Source,
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
 * "created".
 */
async function scanOnce(source: Source, baseline: Map<string, Baseline> | null): Promise<Map<string, Baseline>> {
  const nodes = await source.listTree();
  const current = new Map<string, Baseline>();
  for (const node of nodes) {
    current.set(node.path, { sizeBytes: node.sizeBytes, mtimeMs: node.mtimeMs });
  }

  if (baseline !== null) {
    const events: FileEventInput[] = [];

    for (const [path, stats] of current) {
      const prev = baseline.get(path);
      if (!prev) {
        events.push(await buildEvent(source, "created", path, stats));
      } else if (prev.sizeBytes !== stats.sizeBytes || prev.mtimeMs !== stats.mtimeMs) {
        events.push(await buildEvent(source, "modified", path, stats));
      }
    }
    for (const path of baseline.keys()) {
      if (!current.has(path)) {
        events.push({
          agentKey: config.agentKey,
          eventType: "deleted",
          path,
          occurredAt: new Date().toISOString(),
        });
      }
    }

    for (let i = 0; i < events.length; i += config.eventBatchSize) {
      await postEvents(events.slice(i, i + config.eventBatchSize));
    }
    if (events.length > 0) {
      console.log(`snapshot diff: ${events.length} file event(s)`);
    }
  }

  const totalBytes = nodes.reduce((sum, n) => sum + n.sizeBytes, 0);
  await postStorageSnapshot({
    agentKey: config.agentKey,
    rootPath: source.describe(),
    totalBytes,
    fileCount: nodes.length,
    takenAt: new Date().toISOString(),
  });
  console.log(`storage snapshot: ${nodes.length} files, ${totalBytes} bytes`);

  return current;
}

export function runDiffLoop(source: Source, intervalMs: number): void {
  let baseline: Map<string, Baseline> | null = null;

  async function tick() {
    baseline = await scanOnce(source, baseline);
  }

  console.log(`watching ${source.describe()} via periodic snapshot diff (every ${intervalMs}ms)`);
  tick().catch((err) => console.error("initial snapshot scan failed", err));
  setInterval(() => {
    tick().catch((err) => console.error("snapshot scan failed", err));
  }, intervalMs);
}
