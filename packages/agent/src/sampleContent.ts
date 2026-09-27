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
export async function sampleContent(source: Pick<Source, "readSample">, filePath: string, sizeBytes: number): Promise<ContentSample | null> {
  const extractor = extractorFor(filePath);
  if (!extractor || sizeBytes > MAX_EXTRACT_FILE_BYTES) return null;
  const data = await source.readSample(filePath, extractor === "text" ? 256 * 1024 : MAX_EXTRACT_FILE_BYTES);
  if (!data) return { extractor, note: "couldn't read the file (moved, locked or no access)" };
  const extracted = extractText(filePath, data);
  if (!extracted) return null;
  if (extracted.text === null) return { extractor, note: extracted.note };
  return { extractor, contentSample: Buffer.from(extracted.text, "utf8").toString("base64") };
}
