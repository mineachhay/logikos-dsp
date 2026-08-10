// Pure quarantine-path logic, kept free of any import that touches
// config/env (config.ts validates env vars as an import-time side effect)
// so this is directly unit-testable without a live agent environment —
// same reasoning as diff.ts.

import path from "node:path";

export const QUARANTINE_DIR_NAME = ".logikos-quarantine";

/**
 * Pure — no I/O. Collisions get a numeric suffix rather than overwriting
 * whatever's already in quarantine; the caller is responsible for checking
 * the filesystem and re-calling with an updated `existingNames` set.
 */
export function computeQuarantinePath(
  watchedRoot: string,
  filePath: string,
  existingNames: Set<string> = new Set(),
): string {
  const quarantineDir = path.join(watchedRoot, QUARANTINE_DIR_NAME);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  let candidate = `${base}${ext}`;
  let suffix = 1;
  while (existingNames.has(candidate)) {
    candidate = `${base} (${suffix})${ext}`;
    suffix++;
  }
  return path.join(quarantineDir, candidate);
}
