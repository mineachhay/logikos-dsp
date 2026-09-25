import { describe, expect, it } from "vitest";
import { carryForwardUnreadable, diffSnapshots } from "./diff.js";
import type { Baseline } from "./diff.js";

function baseline(sizeBytes: number, mtimeMs: number): Baseline {
  return { sizeBytes, mtimeMs };
}

describe("diffSnapshots", () => {
  it("reports no changes on the first-ever scan (previous === null)", () => {
    const current = new Map([["a.txt", baseline(10, 1000)]]);
    expect(diffSnapshots(null, current)).toEqual({ created: [], modified: [], deleted: [], renamed: [], copied: [] });
  });

  it("detects a newly created file", () => {
    const previous = new Map<string, Baseline>();
    const current = new Map([["new.txt", baseline(10, 1000)]]);
    const diff = diffSnapshots(previous, current);
    expect(diff.created).toEqual(["new.txt"]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it("detects a modified file by size change", () => {
    const previous = new Map([["a.txt", baseline(10, 1000)]]);
    const current = new Map([["a.txt", baseline(20, 1000)]]);
    expect(diffSnapshots(previous, current).modified).toEqual(["a.txt"]);
  });

  it("detects a modified file by mtime change alone", () => {
    const previous = new Map([["a.txt", baseline(10, 1000)]]);
    const current = new Map([["a.txt", baseline(10, 2000)]]);
    expect(diffSnapshots(previous, current).modified).toEqual(["a.txt"]);
  });

  it("detects a deleted file", () => {
    const previous = new Map([["gone.txt", baseline(10, 1000)]]);
    const current = new Map<string, Baseline>();
    expect(diffSnapshots(previous, current).deleted).toEqual(["gone.txt"]);
  });

  it("reports no changes when nothing about a file differs", () => {
    const previous = new Map([["a.txt", baseline(10, 1000)]]);
    const current = new Map([["a.txt", baseline(10, 1000)]]);
    expect(diffSnapshots(previous, current)).toEqual({ created: [], modified: [], deleted: [], renamed: [], copied: [] });
  });

  it("classifies created, modified, and deleted files together in one scan", () => {
    const previous = new Map([
      ["unchanged.txt", baseline(10, 1000)],
      ["changed.txt", baseline(10, 1000)],
      ["removed.txt", baseline(10, 1000)],
    ]);
    const current = new Map([
      ["unchanged.txt", baseline(10, 1000)],
      ["changed.txt", baseline(99, 1000)],
      ["added.txt", baseline(5, 500)],
    ]);
    expect(diffSnapshots(previous, current)).toEqual({
      created: ["added.txt"],
      modified: ["changed.txt"],
      deleted: ["removed.txt"],
      renamed: [],
      copied: [],
    });
  });
});

describe("diffSnapshots rename detection", () => {
  const baseline = (sizeBytes: number, mtimeMs: number) => ({ sizeBytes, mtimeMs });

  it("reports a renamed file once, not as a delete plus a create", () => {
    const previous = new Map([["New Text Document.txt", baseline(4, 1_000)]]);
    const current = new Map([["rename this file.txt", baseline(4, 1_000)]]);
    const diff = diffSnapshots(previous, current);
    expect(diff.renamed).toEqual([{ from: "New Text Document.txt", to: "rename this file.txt", sizeBytes: 4, mtimeMs: 1_000 }]);
    expect(diff.created).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it("still reports a real delete and a real create", () => {
    const previous = new Map([["gone.txt", baseline(10, 1_000)]]);
    const current = new Map([["fresh.txt", baseline(99, 2_000)]]);
    const diff = diffSnapshots(previous, current);
    expect(diff.renamed).toEqual([]);
    expect(diff.deleted).toEqual(["gone.txt"]);
    expect(diff.created).toEqual(["fresh.txt"]);
  });

  it("won't guess when two files could have become two others", () => {
    const previous = new Map([
      ["a.txt", baseline(0, 1_000)],
      ["b.txt", baseline(0, 1_000)],
    ]);
    const current = new Map([
      ["c.txt", baseline(0, 1_000)],
      ["d.txt", baseline(0, 1_000)],
    ]);
    const diff = diffSnapshots(previous, current);
    expect(diff.renamed).toEqual([]);
    expect(diff.deleted.sort()).toEqual(["a.txt", "b.txt"]);
    expect(diff.created.sort()).toEqual(["c.txt", "d.txt"]);
  });

  it("separates a rename from unrelated changes in the same scan", () => {
    const previous = new Map([
      ["report.csv", baseline(4, 1_000)],
      ["old.txt", baseline(7, 3_000)],
      ["edited.txt", baseline(5, 4_000)],
    ]);
    const current = new Map([
      ["report-final.csv", baseline(4, 1_000)],
      ["edited.txt", baseline(6, 5_000)],
      ["brand-new.txt", baseline(12, 6_000)],
    ]);
    const diff = diffSnapshots(previous, current);
    expect(diff.renamed).toEqual([{ from: "report.csv", to: "report-final.csv", sizeBytes: 4, mtimeMs: 1_000 }]);
    expect(diff.modified).toEqual(["edited.txt"]);
    expect(diff.deleted).toEqual(["old.txt"]);
    expect(diff.created).toEqual(["brand-new.txt"]);
  });

  it("reports a copy as a copy, naming the file it came from", () => {
    const previous = new Map([["report.csv", baseline(4, 1_000)]]);
    const current = new Map([
      ["report.csv", baseline(4, 1_000)],
      ["report copy.csv", baseline(4, 1_000)],
    ]);
    const diff = diffSnapshots(previous, current);
    expect(diff.renamed).toEqual([]);
    expect(diff.created).toEqual([]);
    expect(diff.copied).toEqual([{ from: "report.csv", to: "report copy.csv", sizeBytes: 4, mtimeMs: 1_000 }]);
  });

  it("calls it a rename when the original is gone, and a copy when it stays", () => {
    const previous = new Map([["a.csv", baseline(9, 2_000)]]);
    expect(diffSnapshots(previous, new Map([["b.csv", baseline(9, 2_000)]])).renamed).toHaveLength(1);
    expect(diffSnapshots(previous, new Map([["a.csv", baseline(9, 2_000)], ["b.csv", baseline(9, 2_000)]])).copied).toHaveLength(1);
  });

  it("spots a paste even when the source can't be identified, by its preserved timestamp", () => {
    // Pasted at 10:00, but the file was last written at 09:00 — it can't have
    // been authored in this share since the previous scan.
    const lastScan = 9_500;
    const previous = new Map([["other.txt", baseline(4, 1_000)]]);
    const current = new Map([
      ["other.txt", baseline(4, 1_000)],
      ["IT/pasted.zip", baseline(22, 9_000)],
    ]);
    const diff = diffSnapshots(previous, current, lastScan);
    expect(diff.copied).toEqual([{ from: null, to: "IT/pasted.zip", sizeBytes: 22, mtimeMs: 9_000 }]);
    expect(diff.created).toEqual([]);
  });

  it("still calls a file written since the last scan a create", () => {
    const lastScan = 9_500;
    const previous = new Map([["other.txt", baseline(4, 1_000)]]);
    const current = new Map([
      ["other.txt", baseline(4, 1_000)],
      ["fresh.txt", baseline(12, 12_000)],
    ]);
    const diff = diffSnapshots(previous, current, lastScan);
    expect(diff.copied).toEqual([]);
    expect(diff.created).toEqual(["fresh.txt"]);
  });

  it("names the source when exactly one identical file is still there", () => {
    const lastScan = 9_500;
    const previous = new Map([["HR/report.zip", baseline(22, 9_000)]]);
    const current = new Map([
      ["HR/report.zip", baseline(22, 9_000)],
      ["IT/report.zip", baseline(22, 9_000)],
    ]);
    expect(diffSnapshots(previous, current, lastScan).copied).toEqual([
      { from: "HR/report.zip", to: "IT/report.zip", sizeBytes: 22, mtimeMs: 9_000 },
    ]);
  });

  it("names the source among identical files by the filename a copy keeps", () => {
    const lastScan = 9_500;
    const previous = new Map([
      ["create file.zip", baseline(22, 9_000)],
      ["other archive.zip", baseline(22, 9_000)],
    ]);
    const current = new Map([
      ["create file.zip", baseline(22, 9_000)],
      ["other archive.zip", baseline(22, 9_000)],
      ["IT/create file.zip", baseline(22, 9_000)],
    ]);
    expect(diffSnapshots(previous, current, lastScan).copied).toEqual([
      { from: "create file.zip", to: "IT/create file.zip", sizeBytes: 22, mtimeMs: 9_000 },
    ]);
  });

  it("pairs a move into a subfolder with the file that left, among identical files", () => {
    const previous = new Map([
      ["report.zip", baseline(22, 9_000)],
      ["keep.zip", baseline(22, 9_000)],
    ]);
    const current = new Map([
      ["keep.zip", baseline(22, 9_000)],
      ["archive/report.zip", baseline(22, 9_000)],
    ]);
    const diff = diffSnapshots(previous, current, 9_500);
    expect(diff.renamed).toEqual([{ from: "report.zip", to: "archive/report.zip", sizeBytes: 22, mtimeMs: 9_000 }]);
    expect(diff.deleted).toEqual([]);
    expect(diff.copied).toEqual([]);
  });

  it("won't name a source when several files match — an empty file copied among empty files", () => {

    const previous = new Map([
      ["empty1.txt", baseline(0, 1_000)],
      ["empty2.txt", baseline(0, 1_000)],
    ]);
    const current = new Map([
      ["empty1.txt", baseline(0, 1_000)],
      ["empty2.txt", baseline(0, 1_000)],
      ["empty3.txt", baseline(0, 1_000)],
    ]);
    // No scan time given, so the timestamp rule can't apply either.
    const diff = diffSnapshots(previous, current);
    expect(diff.copied).toEqual([]);
    expect(diff.created).toEqual(["empty3.txt"]);
  });

  it("doesn't call a genuinely new file a copy", () => {
    const previous = new Map([["report.csv", baseline(4, 1_000)]]);
    const current = new Map([["report.csv", baseline(4, 1_000)], ["notes.txt", baseline(88, 9_000)]]);
    expect(diffSnapshots(previous, current).copied).toEqual([]);
    expect(diffSnapshots(previous, current).created).toEqual(["notes.txt"]);
  });
});

describe("carryForwardUnreadable", () => {
  const previous = new Map([
    ["HR/Payroll/june.xlsx", baseline(10, 1000)],
    ["HR/Payroll/2025/may.xlsx", baseline(20, 1000)],
    ["HR/handbook.pdf", baseline(30, 1000)],
    ["HR/PayrollArchive/old.xlsx", baseline(40, 1000)],
  ]);

  it("keeps what an unreadable folder held last time, so it doesn't diff as deleted", () => {
    const current = carryForwardUnreadable(previous, new Map([["HR/handbook.pdf", baseline(30, 1000)]]), ["HR/Payroll"]);
    expect(diffSnapshots(previous, current).deleted).toEqual(["HR/PayrollArchive/old.xlsx"]);
    expect(current.has("HR/Payroll/2025/may.xlsx")).toBe(true);
  });

  it("matches whole folder names, not prefixes of them", () => {
    const current = carryForwardUnreadable(previous, new Map(), ["HR/Payroll"]);
    expect(current.has("HR/PayrollArchive/old.xlsx")).toBe(false);
  });

  it("still reports deletions outside the unreadable folders", () => {
    const current = carryForwardUnreadable(previous, new Map(), ["HR/Payroll"]);
    expect(diffSnapshots(previous, current).deleted.sort()).toEqual(["HR/PayrollArchive/old.xlsx", "HR/handbook.pdf"]);
  });

  it("changes nothing when every folder was readable", () => {
    const current = new Map([["a.txt", baseline(1, 1)]]);
    expect(carryForwardUnreadable(previous, current, [])).toBe(current);
    expect(current.size).toBe(1);
  });
});
