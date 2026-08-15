import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { fetchQuarantineCommands, completeQuarantineCommand } from "./client.js";
import { computeQuarantinePath, QUARANTINE_DIR_NAME } from "./quarantinePath.js";

/**
 * Whatever "move this file into quarantine" means for the active source —
 * local mode does it with `node:fs` directly (below); `SmbSource.quarantine`
 * (sources/smb.ts) is the other implementation. M365 and Google Drive don't
 * have one — those connectors never call `startQuarantinePolling` at all
 * (see index.ts), since the classification worker never suggests
 * FILE_QUARANTINE for them in the first place (watchedRoot.ts).
 */
export interface QuarantineTarget {
  quarantine(filePath: string): Promise<string>;
}

async function quarantineLocalFile(filePath: string): Promise<string> {
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

export const localQuarantineTarget: QuarantineTarget = { quarantine: quarantineLocalFile };

async function quarantineOne(target: QuarantineTarget, filePath: string): Promise<{ ok: true; destination: string } | { ok: false; error: string }> {
  try {
    const destination = await target.quarantine(filePath);
    return { ok: true, destination };
  } catch (err) {
    const error = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "file no longer exists"
      : (err as Error).message;
    return { ok: false, error };
  }
}

// A RANSOMWARE_RATE command can carry many paths (see agentCommands.ts) but
// the ResponseAction it's attached to has one status/resultMessage, not one
// per file — approving it is one click, not N. So this is deliberately
// all-or-nothing at the status level: EXECUTED only if every path
// succeeded, FAILED otherwise, with per-file detail folded into the text
// message rather than the schema. A partially-succeeded burst quarantine
// is visible in the dashboard's message text, not as its own status — a
// known simplification, not an oversight.
async function pollOnce(target: QuarantineTarget): Promise<void> {
  const commands = await fetchQuarantineCommands();
  for (const command of commands) {
    const outcomes = await Promise.all(
      command.paths.map(async (path) => ({ path, result: await quarantineOne(target, path) })),
    );
    const succeeded = outcomes.filter((o): o is { path: string; result: { ok: true; destination: string } } => o.result.ok);
    const failed = outcomes.filter((o): o is { path: string; result: { ok: false; error: string } } => !o.result.ok);

    for (const { path, result } of outcomes) {
      if (result.ok) console.log(`quarantined ${path} -> ${result.destination}`);
      else console.error(`failed to quarantine ${path}: ${result.error}`);
    }

    const message =
      command.paths.length === 1
        ? succeeded.length === 1
          ? `moved to ${succeeded[0].result.destination}`
          : `failed to quarantine ${failed[0].path}: ${failed[0].result.error}`
        : `quarantined ${succeeded.length}/${command.paths.length} file(s)${
            failed.length > 0 ? `; failed: ${failed.map((f) => `${f.path} (${f.result.error})`).join(", ")}` : ""
          }`;

    await completeQuarantineCommand(command.id, failed.length === 0, message);
  }
}

export function startQuarantinePolling(intervalMs: number, target: QuarantineTarget = localQuarantineTarget): void {
  console.log(`polling for quarantine commands every ${intervalMs}ms`);
  pollOnce(target).catch((err) => console.error("quarantine poll failed", err));
  setInterval(() => {
    pollOnce(target).catch((err) => console.error("quarantine poll failed", err));
  }, intervalMs);
}
