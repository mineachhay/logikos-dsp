import { describe, expect, it } from "vitest";
import { parseFilesPage } from "./googledrive.js";

// Shaped from Google's documented Files resource (Drive API v3), restricted
// to exactly the `fields` this connector requests — id, name, mimeType,
// size, modifiedTime, nextPageToken. Includes one native Google Doc (no
// binary content, must be skipped) alongside a folder and a regular file.
const DOCUMENTED_EXAMPLE = {
  files: [
    { id: "1a2b3c", name: "report.pdf", mimeType: "application/pdf", size: "204800", modifiedTime: "2026-01-15T10:30:00Z" },
    { id: "4d5e6f", name: "Finance", mimeType: "application/vnd.google-apps.folder" },
    { id: "7g8h9i", name: "Notes", mimeType: "application/vnd.google-apps.document" },
  ],
  nextPageToken: "EAIaggEI...",
};

describe("parseFilesPage", () => {
  it("separates files from folders and carries nextPageToken through", () => {
    const result = parseFilesPage(DOCUMENTED_EXAMPLE, "");
    expect(result.files.map((f) => f.path)).toEqual(["report.pdf"]);
    expect(result.folders).toEqual([{ id: "4d5e6f", name: "Finance" }]);
    expect(result.nextPageToken).toBe(DOCUMENTED_EXAMPLE.nextPageToken);
  });

  it("skips native Google Docs/Sheets/Slides — no binary content to sample", () => {
    const result = parseFilesPage(DOCUMENTED_EXAMPLE, "");
    expect(result.files.some((f) => f.path === "Notes")).toBe(false);
  });

  it("carries each file's Drive id alongside path/size/mtime", () => {
    const result = parseFilesPage(DOCUMENTED_EXAMPLE, "");
    expect(result.files[0].id).toBe("1a2b3c");
  });

  it("parses the string `size` field into a number", () => {
    const result = parseFilesPage(DOCUMENTED_EXAMPLE, "");
    expect(result.files[0].sizeBytes).toBe(204800);
  });

  it("converts modifiedTime to epoch milliseconds", () => {
    const result = parseFilesPage(DOCUMENTED_EXAMPLE, "");
    expect(result.files[0].mtimeMs).toBe(new Date("2026-01-15T10:30:00Z").getTime());
  });

  it("prefixes file paths with the current relative directory", () => {
    const result = parseFilesPage(DOCUMENTED_EXAMPLE, "Finance/2024");
    expect(result.files[0].path).toBe("Finance/2024/report.pdf");
  });

  it("defaults size to 0 and mtime to 0 when the API omits them", () => {
    const result = parseFilesPage({ files: [{ id: "x", name: "empty.txt", mimeType: "text/plain" }] }, "");
    expect(result.files[0].sizeBytes).toBe(0);
    expect(result.files[0].mtimeMs).toBe(0);
  });

  it("returns null nextPageToken when the response has no more pages", () => {
    const result = parseFilesPage({ files: [] }, "");
    expect(result.nextPageToken).toBeNull();
    expect(result.files).toEqual([]);
    expect(result.folders).toEqual([]);
  });

  it("handles a response with no files array at all", () => {
    const result = parseFilesPage({}, "");
    expect(result).toEqual({ files: [], folders: [], nextPageToken: null });
  });
});
