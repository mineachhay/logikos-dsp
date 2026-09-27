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
/** Settings → Content discovery; the defaults are the built-in limits. */
export interface PlanOptions {
  maxFileBytes: number;
  /** Extractors allowed: text, docx, xlsx, pptx, pdf. */
  fileTypes: ReadonlySet<string>;
  /** Paths skipped (always-excluded ones plus the configured patterns); counted with other types. */
  exclude: readonly RegExp[];
}

const DEFAULT_OPTIONS: PlanOptions = { maxFileBytes: MAX_EXTRACT_FILE_BYTES, fileTypes: new Set(["text", "docx", "xlsx", "pptx", "pdf"]), exclude: [] };

export function planDiscovery(files: ReadonlyMap<string, KnownFile>, done: ReadonlyMap<string, string>, options: PlanOptions = DEFAULT_OPTIONS): DiscoveryPlan {
  let candidates = 0;
  let skippedType = 0;
  let skippedSize = 0;
  const todo: string[] = [];
  for (const [path, f] of files) {
    const extractor = extractorFor(path);
    if (!extractor || !options.fileTypes.has(extractor) || options.exclude.some((re) => re.test(path))) {
      skippedType++;
      continue;
    }
    if (f.sizeBytes > options.maxFileBytes) {
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
