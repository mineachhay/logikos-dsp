import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { fetchQuarantineCommands, completeQuarantineCommand } from "./client.js";
import { computeQuarantinePath, QUARANTINE_DIR_NAME } from "./quarantinePath.js";

async function quarantineFile(filePath: string): Promise<string> {
  const quarantineDir = path.join(config.watchPath, QUARANTINE_DIR_NAME);
  await mkdir(quarantineDir, { recursive: true });

  const existingNames = new Set<string>();
  let destination = computeQuarantinePath(config.watchPath, filePath);
  while (existsSync(destination)) {
    existingNames.add(path.basename(destination));
    destination = computeQuarantinePath(config.watchPath, filePath, existingNames);
  }

  await rename(filePath, destination);
  return destination;
}

async function pollOnce(): Promise<void> {
  const commands = await fetchQuarantineCommands();
  for (const command of commands) {
    try {
      const destination = await quarantineFile(command.path);
      console.log(`quarantined ${command.path} -> ${destination}`);
      await completeQuarantineCommand(command.id, true, `moved to ${destination}`);
    } catch (err) {
      const message = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `file no longer exists at ${command.path}`
        : `failed to quarantine ${command.path}: ${(err as Error).message}`;
      console.error(message);
      await completeQuarantineCommand(command.id, false, message);
    }
  }
}

export function startQuarantinePolling(intervalMs: number): void {
  console.log(`polling for quarantine commands every ${intervalMs}ms`);
  pollOnce().catch((err) => console.error("quarantine poll failed", err));
  setInterval(() => {
    pollOnce().catch((err) => console.error("quarantine poll failed", err));
  }, intervalMs);
}
