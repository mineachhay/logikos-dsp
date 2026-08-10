import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { postStorageSnapshot } from "./client.js";

async function walk(dir: string): Promise<{ totalBytes: number; fileCount: number }> {
  let totalBytes = 0;
  let fileCount = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { totalBytes, fileCount };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walk(full);
      totalBytes += sub.totalBytes;
      fileCount += sub.fileCount;
    } else if (entry.isFile()) {
      try {
        const s = await stat(full);
        totalBytes += s.size;
        fileCount += 1;
      } catch {
        // file disappeared mid-walk; skip it
      }
    }
  }
  return { totalBytes, fileCount };
}

async function scanOnce() {
  const { totalBytes, fileCount } = await walk(config.watchPath);
  await postStorageSnapshot({
    agentKey: config.agentKey,
    rootPath: config.watchPath,
    totalBytes,
    fileCount,
    takenAt: new Date().toISOString(),
  });
  console.log(`storage snapshot: ${fileCount} files, ${totalBytes} bytes`);
}

export function startStorageScan(): void {
  scanOnce().catch((err) => console.error("initial storage scan failed", err));
  setInterval(() => {
    scanOnce().catch((err) => console.error("storage scan failed", err));
  }, config.storageScanIntervalMs);
}
