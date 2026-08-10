// Pure snapshot-diffing logic, deliberately kept free of any import that
// touches config/env (config.ts validates env vars as an import-time side
// effect) so this — the core of the SMB connector's change detection — can
// be unit tested in isolation, without a live Source, backend, or WATCH_PATH.

export interface Baseline {
  sizeBytes: number;
  mtimeMs: number;
}

export interface DiffResult {
  created: string[];
  modified: string[];
  deleted: string[];
}

/**
 * `previous === null` means "first scan ever" and intentionally returns no
 * changes, mirroring chokidar's ignoreInitial in watcher.ts — an agent
 * restart shouldn't replay a share's entire existing contents as "created".
 */
export function diffSnapshots(previous: Map<string, Baseline> | null, current: Map<string, Baseline>): DiffResult {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  if (previous === null) {
    return { created, modified, deleted };
  }

  for (const [path, stats] of current) {
    const prev = previous.get(path);
    if (!prev) {
      created.push(path);
    } else if (prev.sizeBytes !== stats.sizeBytes || prev.mtimeMs !== stats.mtimeMs) {
      modified.push(path);
    }
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) {
      deleted.push(path);
    }
  }

  return { created, modified, deleted };
}
