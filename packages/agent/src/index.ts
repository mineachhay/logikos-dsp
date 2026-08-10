import { config } from "./config.js"; // validates env vars at import time, before anything else runs
import { registerAgent } from "./client.js";
import { startWatcher } from "./watcher.js";
import { startStorageScan } from "./storageScan.js";
import { SmbSource } from "./sources/smb.js";
import { M365Source } from "./sources/m365.js";
import { runDiffLoop } from "./snapshotDiff.js";
import { startQuarantinePolling } from "./quarantine.js";

async function main() {
  await registerAgent();

  if (config.sourceType === "local") {
    startWatcher();
    startStorageScan();
    // Quarantine needs direct filesystem write access to the watched root,
    // which only a local-path agent has — SMB and M365 both stay read-only.
    startQuarantinePolling(config.quarantinePollIntervalMs);
  } else if (config.sourceType === "smb") {
    const source = new SmbSource(config.smb);
    runDiffLoop(source, config.smbScanIntervalMs);
  } else {
    const source = new M365Source(config.m365);
    runDiffLoop(source, config.m365ScanIntervalMs);
  }
}

main().catch((err) => {
  console.error("agent failed to start", err);
  process.exit(1);
});
