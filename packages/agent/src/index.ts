import { config } from "./config.js"; // validates env vars at import time, before anything else runs
import { registerAgent } from "./client.js";
import { startWatcher } from "./watcher.js";
import { startStorageScan } from "./storageScan.js";
import { SmbSource } from "./sources/smb.js";
import { runDiffLoop } from "./snapshotDiff.js";
import { startQuarantinePolling } from "./quarantine.js";

async function main() {
  await registerAgent();

  if (config.sourceType === "local") {
    startWatcher();
    startStorageScan();
    // Quarantine needs direct filesystem write access to the watched root,
    // which only a local-path agent has — the SMB connector stays read-only.
    startQuarantinePolling(config.quarantinePollIntervalMs);
  } else {
    const source = new SmbSource(config.smb);
    runDiffLoop(source, config.smbScanIntervalMs);
  }
}

main().catch((err) => {
  console.error("agent failed to start", err);
  process.exit(1);
});
