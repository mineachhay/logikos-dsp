import "./config.js"; // validates WATCH_PATH at import time, before anything else runs
import { registerAgent } from "./client.js";
import { startWatcher } from "./watcher.js";
import { startStorageScan } from "./storageScan.js";

async function main() {
  await registerAgent();
  startWatcher();
  startStorageScan();
}

main().catch((err) => {
  console.error("agent failed to start", err);
  process.exit(1);
});
