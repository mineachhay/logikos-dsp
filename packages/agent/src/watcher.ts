import chokidar from "chokidar";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FileEventInput, FileEventType } from "@logikos-dsp/shared";
import { config } from "./config.js";
import { postEvents } from "./client.js";

const TEXTISH_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".log", ".md", ".xml", ".yaml", ".yml", ".sql", ".ini", ".conf",
]);

let queue: FileEventInput[] = [];

function enqueue(evt: FileEventInput) {
  queue.push(evt);
}

async function flush() {
  if (queue.length === 0) return;
  const batch = queue.splice(0, config.eventBatchSize);
  await postEvents(batch);
}

async function sampleContent(filePath: string, sizeBytes: number): Promise<string | undefined> {
  if (sizeBytes > 5 * 1024 * 1024) return undefined; // don't bother reading huge files for a content sample
  if (!TEXTISH_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return undefined;
  try {
    const buf = await readFile(filePath);
    return buf.subarray(0, config.maxContentSampleBytes).toString("base64");
  } catch {
    return undefined; // file may have been deleted/moved between the fs event and this read
  }
}

async function handle(eventType: FileEventType, filePath: string) {
  let sizeBytes: number | undefined;
  let contentSample: string | undefined;
  if (eventType === "created" || eventType === "modified") {
    try {
      const s = await stat(filePath);
      sizeBytes = s.size;
      contentSample = await sampleContent(filePath, s.size);
    } catch {
      // stat failed (already gone); still record the event, just without size/content
    }
  }
  enqueue({
    agentKey: config.agentKey,
    eventType,
    path: filePath,
    sizeBytes,
    occurredAt: new Date().toISOString(),
    contentSample,
  });
}

export function startWatcher(): void {
  const watcher = chokidar.watch(config.watchPath, {
    ignoreInitial: true, // don't emit "created" for every file that already existed at startup
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  // chokidar reports moves as unlink+add and doesn't expose permission-only
  // changes, so this watcher never emits "renamed" or "permission_changed"
  // even though the wire contract supports them — a native agent (Windows
  // USN journal, Linux fanotify) can distinguish those directly. Tracked as
  // a v2 improvement alongside the Go/Rust agent rewrite, not implemented here.
  watcher.on("add", (p) => handle("created", p));
  watcher.on("change", (p) => handle("modified", p));
  watcher.on("unlink", (p) => handle("deleted", p));

  setInterval(() => {
    flush().catch((err) => console.error("failed to flush events", err));
  }, config.eventFlushIntervalMs);

  console.log(`watching ${config.watchPath} for file events`);
}
