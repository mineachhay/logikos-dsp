// Pure snapshot-diffing logic, deliberately kept free of any import that
// touches config/env (config.ts validates env vars as an import-time side
// effect) so this — the core of the SMB connector's change detection — can
// be unit tested in isolation, without a live Source, backend, or WATCH_PATH.

export interface Baseline {
  sizeBytes: number;
  mtimeMs: number;
}

export interface RenamedFile {
  from: string;
  to: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface DiffResult {
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: RenamedFile[];
}

/**
 * A scan compares two lists of paths, so a rename looks like a delete plus a
 * create. Renaming doesn't change a file's contents, so the two halves still
 * share an exact size and modification time — pair them on that and report
 * the rename instead.
 *
 * Only unambiguous pairs count: if two files disappeared and two appeared
 * with the same size and timestamp (several empty files created in the same
 * second, say), there's no way to tell which became which, so they stay as
 * deletes and creates rather than inventing a pairing.
 */
function pairRenames(
  deleted: string[],
  created: string[],
  previous: Map<string, Baseline>,
  current: Map<string, Baseline>,
): { renamed: RenamedFile[]; deleted: string[]; created: string[] } {
  const key = (s: Baseline) => `${s.sizeBytes}:${s.mtimeMs}`;
  const byKey = new Map<string, { from: string[]; to: string[] }>();
  for (const path of deleted) {
    const entry = byKey.get(key(previous.get(path)!)) ?? { from: [], to: [] };
    entry.from.push(path);
    byKey.set(key(previous.get(path)!), entry);
  }
  for (const path of created) {
    const stats = current.get(path)!;
    const entry = byKey.get(key(stats));
    if (entry) entry.to.push(path);
  }

  const renamed: RenamedFile[] = [];
  const pairedFrom = new Set<string>();
  const pairedTo = new Set<string>();
  for (const entry of byKey.values()) {
    if (entry.from.length !== 1 || entry.to.length !== 1) continue;
    const [from] = entry.from;
    const [to] = entry.to;
    const stats = current.get(to)!;
    renamed.push({ from, to, sizeBytes: stats.sizeBytes, mtimeMs: stats.mtimeMs });
    pairedFrom.add(from);
    pairedTo.add(to);
  }

  return {
    renamed,
    deleted: deleted.filter((p) => !pairedFrom.has(p)),
    created: created.filter((p) => !pairedTo.has(p)),
  };
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
    return { created, modified, deleted, renamed: [] };
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

  return { modified, ...pairRenames(deleted, created, previous, current) };
}
