import { describe, expect, it } from "vitest";
import { doneKey, planDiscovery } from "./discoveryPlan.js";

describe("planDiscovery", () => {
  const files = new Map([
    ["a/report.docx", { sizeBytes: 1000, mtimeMs: 3000 }],
    ["a/old.xlsx", { sizeBytes: 2000, mtimeMs: 1000 }],
    ["a/photo.jpg", { sizeBytes: 5000, mtimeMs: 2000 }],
    ["a/huge.pdf", { sizeBytes: 100 * 1024 * 1024, mtimeMs: 2000 }],
    ["a/notes.txt", { sizeBytes: 10, mtimeMs: 2000 }],
  ]);

  it("counts what it can and can't read, and examines the rest newest first", () => {
    expect(planDiscovery(files, new Map())).toEqual({
      candidates: 3,
      todo: ["a/report.docx", "a/notes.txt", "a/old.xlsx"],
      skippedType: 1,
      skippedSize: 1,
    });
  });

  it("skips files already examined, but not ones that changed since", () => {
    const done = new Map([
      ["a/report.docx", doneKey({ sizeBytes: 1000, mtimeMs: 3000 })],
      ["a/old.xlsx", doneKey({ sizeBytes: 1999, mtimeMs: 1000 })], // changed size
    ]);
    expect(planDiscovery(files, done).todo).toEqual(["a/notes.txt", "a/old.xlsx"]);
  });

  it("follows the configured types, size limit and skip patterns", () => {
    const plan = planDiscovery(files, new Map(), { maxFileBytes: 1500, fileTypes: new Set(["docx", "xlsx", "text"]), exclude: [/^a\/notes\.txt$/i] });
    // report.docx only: old.xlsx is too large; photo.jpg and huge.pdf aren't allowed types; notes.txt is excluded.
    expect(plan).toEqual({ candidates: 1, todo: ["a/report.docx"], skippedType: 3, skippedSize: 1 });
  });
});
