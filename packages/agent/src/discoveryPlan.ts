// Pure planning for content discovery (contentDiscovery.ts) — which files a pass
// should examine. No config import, so it's unit tested.
import { MAX_EXTRACT_FILE_BYTES, extractorFor } from "./textExtract.js";

export interface KnownFile {
  sizeBytes: number;
  mtimeMs: number;
}

export interface DiscoveryPlan {
  /** Files of a readable type and size, examined or not. */
  candidates: number;
  /** Candidates not examined yet, or changed since (size or time differs). */
  todo: string[];
  skippedType: number;
  skippedSize: number;
}

/** `done` maps path → "size:mtime" as examined; the key tells a changed file from an unchanged one. */
export function planDiscovery(files: ReadonlyMap<string, KnownFile>, done: ReadonlyMap<string, string>): DiscoveryPlan {
  let candidates = 0;
  let skippedType = 0;
  let skippedSize = 0;
  const todo: string[] = [];
  for (const [path, f] of files) {
    if (!extractorFor(path)) {
      skippedType++;
      continue;
    }
    if (f.sizeBytes > MAX_EXTRACT_FILE_BYTES) {
      skippedSize++;
      continue;
    }
    candidates++;
    if (done.get(path) !== doneKey(f)) todo.push(path);
  }
  // Newest first: recently touched files are the likeliest to matter now.
  todo.sort((a, b) => files.get(b)!.mtimeMs - files.get(a)!.mtimeMs);
  return { candidates, todo, skippedType, skippedSize };
}

export function doneKey(f: KnownFile): string {
  return `${f.sizeBytes}:${Math.round(f.mtimeMs)}`;
}
