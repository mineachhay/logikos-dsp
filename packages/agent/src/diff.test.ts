import { describe, expect, it } from "vitest";
import { diffSnapshots } from "./diff.js";
import type { Baseline } from "./diff.js";

function baseline(sizeBytes: number, mtimeMs: number): Baseline {
  return { sizeBytes, mtimeMs };
}

describe("diffSnapshots", () => {
  it("reports no changes on the first-ever scan (previous === null)", () => {
    const current = new Map([["a.txt", baseline(10, 1000)]]);
    expect(diffSnapshots(null, current)).toEqual({ created: [], modified: [], deleted: [] });
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
    expect(diffSnapshots(previous, current)).toEqual({ created: [], modified: [], deleted: [] });
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
    });
  });
});
