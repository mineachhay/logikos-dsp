// Pure snapshot-diffing logic, deliberately kept free of any import that
// touches config/env (config.ts validates env vars as an import-time side
// effect) so this — the core of the SMB connector's change detection — can
// be unit tested in isolation, without a live Source, backend, or WATCH_PATH.

export interface Baseline {
  sizeBytes: number;
  mtimeMs: number;
}

/** Last path segment, lowercased — paths here are always "/"-separated. */
function baseName(path: string): string {
  return (path.split("/").pop() ?? path).toLowerCase();
}

/**
 * Which of several identical files a new path came from. Identical size and
 * timestamp can't tell them apart, but a copy or a move almost always keeps
 * its filename — enough to name the source when exactly one candidate shares
 * it. Otherwise nothing is named: a wrong source is worse than none.
 */
function chooseSource(candidates: readonly string[], target: string): string | null {
  if (candidates.length === 1) return candidates[0];
  const sameName = candidates.filter((c) => baseName(c) === baseName(target));
  return sameName.length === 1 ? sameName[0] : null;
}

export interface RenamedFile {
  from: string;
  to: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface CopiedFile {
  /** The file it was copied from, when that file is still in the share and identifiable. */
  from: string | null;
  to: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface DiffResult {
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: RenamedFile[];
  copied: CopiedFile[];
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
    if (entry.from.length === 0 || entry.to.length === 0) continue;
    for (const to of entry.to) {
      const available = entry.from.filter((f) => !pairedFrom.has(f));
      const from = chooseSource(available, to);
      if (!from) continue;
      const stats = current.get(to)!;
      renamed.push({ from, to, sizeBytes: stats.sizeBytes, mtimeMs: stats.mtimeMs });
      pairedFrom.add(from);
      pairedTo.add(to);
    }
  }

  return {
    renamed,
    deleted: deleted.filter((p) => !pairedFrom.has(p)),
    created: created.filter((p) => !pairedTo.has(p)),
  };
}

/**
 * Copying a file keeps its size and last-write time, so a new path whose
 * size and mtime match a file that is *still there* is a copy of it — the
 * difference from a rename, where the original is gone.
 *
 * Only unambiguous matches count: several empty files share a size and
 * timestamp, and "copied from one of these four" is not worth saying, so
 * those stay ordinary creates.
 */
function pairCopies(
  created: string[],
  previous: Map<string, Baseline>,
  current: Map<string, Baseline>,
  previousScanAt: number | undefined,
): { copied: CopiedFile[]; created: string[] } {
  const key = (s: Baseline) => `${s.sizeBytes}:${s.mtimeMs}`;
  const survivors = new Map<string, string[]>();
  for (const [path, stats] of current) {
    // Only files that were already there: a file that appeared in this same
    // scan is another new file, not the thing this one was copied from.
    if (!previous.has(path)) continue;
    const list = survivors.get(key(stats)) ?? [];
    list.push(path);
    survivors.set(key(stats), list);
  }

  const copied: CopiedFile[] = [];
  const paired = new Set<string>();
  for (const path of created) {
    const stats = current.get(path)!;
    // Empty files carry no evidence: every empty file matches every other one.
    const candidates = stats.sizeBytes > 0 ? (survivors.get(key(stats)) ?? []) : [];
    const source = chooseSource(candidates, path);

    // Copying preserves the last-write time, so a file whose contents predate
    // the previous scan can't have been written here since — it was copied or
    // moved in, even when its source isn't in this share (a paste from a
    // desktop) or can't be told apart from other identical files.
    const olderThanLastScan = previousScanAt !== undefined && stats.mtimeMs < previousScanAt;
    if (!source && !olderThanLastScan) continue;

    copied.push({
      from: source,
      to: path,
      sizeBytes: stats.sizeBytes,
      mtimeMs: stats.mtimeMs,
    });
    paired.add(path);
  }
  return { copied, created: created.filter((p) => !paired.has(p)) };
}

/**
 * `previous === null` means "first scan ever" and intentionally returns no
 * changes, mirroring chokidar's ignoreInitial in watcher.ts — an agent
 * restart shouldn't replay a share's entire existing contents as "created".
 */
export function diffSnapshots(
  previous: Map<string, Baseline> | null,
  current: Map<string, Baseline>,
  /** When the previous snapshot was taken — lets a preserved timestamp identify a copy. */
  previousScanAt?: number,
): DiffResult {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  if (previous === null) {
    return { created, modified, deleted, renamed: [], copied: [] };
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

  // Renames first: they consume a delete and a create, and a copy's original
  // is by definition still present.
  const afterRenames = pairRenames(deleted, created, previous, current);
  const afterCopies = pairCopies(afterRenames.created, previous, current, previousScanAt);
  return { modified, deleted: afterRenames.deleted, renamed: afterRenames.renamed, ...afterCopies };
}

/**
 * Folders the walk couldn't read keep what the previous walk saw in them.
 * Leaving them out would diff as every file inside being DELETED — a
 * permission change on one folder would read as a mass deletion and trip the
 * ransomware-rate rule. Mutates and returns `current`. Paths are "/"-separated
 * and relative to the source root; `unreadable` are folder paths like "HR/Payroll".
 */
export function carryForwardUnreadable(
  previous: Map<string, Baseline>,
  current: Map<string, Baseline>,
  unreadable: readonly string[],
): Map<string, Baseline> {
  if (unreadable.length === 0) return current;
  const prefixes = unreadable.map((dir) => `${dir.replace(/\/+$/, "")}/`);
  for (const [path, stats] of previous) {
    if (!current.has(path) && prefixes.some((prefix) => path.startsWith(prefix))) current.set(path, stats);
  }
  return current;
}
