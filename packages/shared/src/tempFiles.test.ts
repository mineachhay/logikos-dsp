import { describe, expect, it } from "vitest";
import { isTemporaryFile } from "./tempFiles.js";

describe("isTemporaryFile", () => {
  it("recognises Office lock and save files on shares and local paths", () => {
    expect(isTemporaryFile("18_Roster/2026/~$9-SEP-2026_DPT.xlsx")).toBe(true);
    expect(isTemporaryFile("C:\\Users\\a\\Documents\\~WRL0003.tmp")).toBe(true);
    expect(isTemporaryFile("~$Book1.xlsx")).toBe(true);
    expect(isTemporaryFile("x/report.TMP")).toBe(true);
  });
  it("leaves real files alone", () => {
    expect(isTemporaryFile("18_Roster/2026/9-SEP-2026_DPT.xlsx")).toBe(false);
    expect(isTemporaryFile("a~b/notes.txt")).toBe(false);
    expect(isTemporaryFile("temp/tmp-report.docx")).toBe(false);
  });
});
