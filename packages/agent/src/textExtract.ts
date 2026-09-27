// Text out of the files people actually keep sensitive data in, for
// classification. Pure (no I/O, no config import) so it's unit tested.
//
// The classifier only ever saw the first 8 KB of plain-text files, so Word,
// Excel, PowerPoint and PDF — compressed containers whose first bytes are zip
// headers or PDF syntax — were never examined at all.
import path from "node:path";
import { inflateSync } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";

export const TEXT_EXTENSIONS = new Set([".txt", ".csv", ".json", ".log", ".md", ".xml", ".yaml", ".yml", ".sql", ".ini", ".conf", ".tsv", ".htm", ".html"]);
export const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
export const PDF_EXTENSIONS = new Set([".pdf"]);

/** Larger files are skipped: reading them whole over SMB to find text isn't worth the load. */
export const MAX_EXTRACT_FILE_BYTES = 25 * 1024 * 1024;
/** How much extracted text is classified — enough for a table of IDs, bounded for the NER model. */
export const MAX_TEXT_CHARS = 32 * 1024;

export type Extractor = "text" | "docx" | "xlsx" | "pptx" | "pdf";

export function extractorFor(filePath: string): Extractor | null {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (OFFICE_EXTENSIONS.has(ext)) return ext.slice(1) as Extractor;
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  return null;
}

export type Extracted = { extractor: Extractor; text: string } | { extractor: Extractor; text: null; note: string };

export function extractText(filePath: string, data: Uint8Array): Extracted | null {
  const extractor = extractorFor(filePath);
  if (!extractor) return null;
  try {
    const text = extractor === "text" ? decodeText(data) : extractor === "pdf" ? pdfText(data) : officeText(extractor, data);
    const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) {
      return { extractor, text: null, note: extractor === "pdf" ? "no text layer (scanned PDF?)" : "no text found" };
    }
    return { extractor, text: clean.slice(0, MAX_TEXT_CHARS) };
  } catch (err) {
    return { extractor, text: null, note: `couldn't read the file: ${(err as Error).message.slice(0, 120)}` };
  }
}

function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  return new TextDecoder("utf-8").decode(data);
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (XML_ENTITIES[e] ?? m),
  );
}

/** The text content of the given elements, in document order, one per line. */
function elementTexts(xml: string, tag: RegExp): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(tag)) out.push(unescapeXml(m[1] ?? ""));
  return out;
}

/**
 * docx/xlsx/pptx are zip archives of XML parts; the words are in <w:t>,
 * <a:t> and, for Excel, shared strings (<t>) plus cell values (<v>) — a
 * number typed into a cell (an ID, a card number) is a <v>, never a string.
 */
function officeText(kind: Extractor, data: Uint8Array): string {
  const wanted = (name: string) =>
    kind === "docx"
      ? /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)
      : kind === "xlsx"
        ? name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
        : /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name);
  const parts = unzipSync(data, { filter: (f) => wanted(f.name) });
  const names = Object.keys(parts).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const lines: string[] = [];
  for (const name of names) {
    const xml = strFromU8(parts[name]!);
    if (kind === "docx") lines.push(xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").match(/<w:t[^>]*>[^<]*<\/w:t>|\n|\t/g)?.map((t) => (t.startsWith("<") ? unescapeXml(t.replace(/<[^>]+>/g, "")) : t)).join("") ?? "");
    else if (kind === "pptx") lines.push(...elementTexts(xml, /<a:t>([^<]*)<\/a:t>/g));
    else if (name.endsWith("sharedStrings.xml")) lines.push(...elementTexts(xml, /<t[^>]*>([^<]*)<\/t>/g));
    // Worksheet: numeric cell values and inline strings (not type="s" indexes into sharedStrings).
    else for (const c of xml.matchAll(/<c\b([^>]*)>(.*?)<\/c>/g)) {
      const attrs = c[1] ?? "";
      if (/\bt="s"/.test(attrs)) continue;
      const v = /<v>([^<]*)<\/v>/.exec(c[2] ?? "")?.[1] ?? /<t[^>]*>([^<]*)<\/t>/.exec(c[2] ?? "")?.[1];
      if (v) lines.push(unescapeXml(v));
    }
    if (lines.join("\n").length > MAX_TEXT_CHARS * 2) break;
  }
  return lines.join("\n");
}

/**
 * The text a PDF draws: its content streams (usually Flate-compressed),
 * reading the strings shown by Tj / TJ / ' / ". Good for PDFs made from
 * documents; a scan is only pictures (no text layer), and fonts with custom
 * encodings can come out garbled — the result says so rather than guessing.
 */
function pdfText(data: Uint8Array): string {
  const bytes = Buffer.from(data);
  const latin = bytes.toString("latin1");
  const chunks: string[] = [];
  const streamRe = /<<([^]*?)>>\s*stream\r?\n/g;
  for (let m = streamRe.exec(latin); m; m = streamRe.exec(latin)) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    const dict = m[1] ?? "";
    let body: Buffer = bytes.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        body = inflateSync(body);
      } catch {
        continue; // images, fonts or damaged streams — not text
      }
    } else if (/\/Filter/.test(dict)) {
      continue; // other encodings (images, mostly)
    }
    const content = body.toString("latin1");
    if (!/T[jJ*'"]|BT/.test(content)) continue;
    chunks.push(showStrings(content));
    streamRe.lastIndex = end;
    if (chunks.join("").length > MAX_TEXT_CHARS * 2) break;
  }
  return chunks.join("\n");
}

/** Strings from text-showing operators in one content stream, with line breaks where the text moves down. */
function showStrings(content: string): string {
  let out = "";
  const re = /\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|T\*|Td|TD|Tm|ET|'|"/g;
  for (const m of content.matchAll(re)) {
    const tok = m[0];
    if (tok === "T*" || tok === "Td" || tok === "TD" || tok === "Tm" || tok === "ET" || tok === "'" || tok === '"') {
      if (!out.endsWith("\n")) out += tok === "Td" || tok === "Tm" ? " " : "\n";
      continue;
    }
    if (tok.startsWith("(")) out += unescapePdf(tok.slice(1, -1));
    else if (tok.startsWith("<") && !tok.startsWith("<<")) {
      const hex = tok.slice(1, -1).replace(/\s/g, "");
      // Two-byte hex strings are usually glyph IDs (Identity-H) — unreadable without the font's map.
      if (hex.length % 4 === 0 && /^00/.test(hex)) out += Buffer.from(hex, "hex").swap16().toString("utf16le").replace(/[^\x20-\x7e]/g, ""); // UTF-16BE
      else out += Buffer.from(hex, "hex").toString("latin1");
    }
  }
  return out;
}

function unescapePdf(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, e: string) => {
    const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    return map[e] ?? String.fromCharCode(parseInt(e, 8));
  });
}
