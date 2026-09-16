import { describe, expect, it } from "vitest";
import { diffSnapshots } from "./diff.js";
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
