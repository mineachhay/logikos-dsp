export interface FileNode {
  /** Path relative to the source root, e.g. "finance/q1.csv". */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * A pluggable place the agent can watch. `local` (chokidar, real-time) and
 * `smb` (this connector, periodic snapshot-diff) are the two implementations;
 * see ARCHITECTURE.md for why they use different detection strategies.
 */
export interface Source {
  /** Human-readable root label sent to the backend as Agent.watchedRoot, e.g. "smb://host/share/sub". */
  describe(): string;
  /** Full recursive walk of the source, files only (no directory entries). */
  listTree(): Promise<FileNode[]>;
  /** First `maxBytes` of a file's content, or undefined if unavailable/unreadable. */
  readSample(relPath: string, maxBytes: number): Promise<Buffer | undefined>;
}
