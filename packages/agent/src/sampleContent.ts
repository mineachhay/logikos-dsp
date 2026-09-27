import type { Source } from "./sources/types.js";
import { MAX_EXTRACT_FILE_BYTES, extractText, extractorFor, type Extractor } from "./textExtract.js";

export interface ContentSample {
  extractor: Extractor;
  /** Base64 of the extracted text (not the raw bytes), for classification. */
  contentSample?: string;
  /** Why there's no sample. */
  note?: string;
}

/**
 * Reads a file from `source` and extracts its text for classification — the
 * one path both changed files (snapshotDiff) and content discovery use, so a
 * changed .docx and a discovered one are treated alike. Null for formats that
 * can't be read or files too large to fetch whole.
 */
export async function sampleContent(
  source: Pick<Source, "readSample">,
  filePath: string,
  sizeBytes: number,
  maxFileBytes = MAX_EXTRACT_FILE_BYTES,
): Promise<ContentSample | null> {
  const extractor = extractorFor(filePath);
  if (!extractor || sizeBytes > maxFileBytes) return null;
  const data = await source.readSample(filePath, extractor === "text" ? 256 * 1024 : maxFileBytes);
  if (!data) return { extractor, note: "couldn't read the file (moved, locked or no access)" };
  const extracted = extractText(filePath, data);
  if (!extracted) return null;
  if (extracted.text === null) return { extractor, note: extracted.note };
  return { extractor, contentSample: toSample(extracted.text) };
}

/**
 * The backend takes at most 64 KiB of base64 per sample — 48 KiB of UTF-8.
 * The extractor caps text in characters, and Khmer or Thai text is three bytes
 * a character, so a 32K-character sample came out at 128 KiB and the backend
 * rejected the whole batch it was in. Cut at a character boundary.
 */
export const MAX_SAMPLE_UTF8_BYTES = 48 * 1024;

export function toSample(text: string): string {
  let buf = Buffer.from(text, "utf8");
  if (buf.length > MAX_SAMPLE_UTF8_BYTES) {
    // A character cut in half decodes to U+FFFD (3 bytes); drop it.
    buf = Buffer.from(buf.subarray(0, MAX_SAMPLE_UTF8_BYTES).toString("utf8").replace(/\uFFFD$/, ""), "utf8");
  }
  return buf.toString("base64");
}
