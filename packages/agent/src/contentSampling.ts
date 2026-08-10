import path from "node:path";

export const TEXTISH_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".log", ".md", ".xml", ".yaml", ".yml", ".sql", ".ini", ".conf",
]);

export const MAX_SAMPLEABLE_FILE_BYTES = 5 * 1024 * 1024;

/** True if a file is a candidate for content sampling, based on extension and size alone (no I/O). */
export function isSampleable(filePath: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_SAMPLEABLE_FILE_BYTES) return false;
  return TEXTISH_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
