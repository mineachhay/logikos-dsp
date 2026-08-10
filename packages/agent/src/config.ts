import os from "node:os";
import { createHash } from "node:crypto";
import { CLASSIFICATION_JOB_MAX_SAMPLE_BYTES } from "@logikos-dsp/shared";

const watchPath = process.env.WATCH_PATH;
if (!watchPath) {
  console.error("WATCH_PATH environment variable is required (the directory this agent watches)");
  process.exit(1);
}

// Deterministic per (host, watchPath) so restarting the agent re-registers
// under the same key instead of minting a new Agent row every time.
const derivedKey = `agent-${createHash("sha256").update(`${os.hostname()}:${watchPath}`).digest("hex").slice(0, 24)}`;

export const config = {
  backendUrl: process.env.BACKEND_URL ?? "http://localhost:4000",
  watchPath,
  agentKey: process.env.AGENT_KEY ?? derivedKey,
  hostname: os.hostname(),
  storageScanIntervalMs: Number(process.env.STORAGE_SCAN_INTERVAL_MS ?? 60_000),
  eventFlushIntervalMs: Number(process.env.EVENT_FLUSH_INTERVAL_MS ?? 500),
  eventBatchSize: 50,
  maxContentSampleBytes: CLASSIFICATION_JOB_MAX_SAMPLE_BYTES,
};
