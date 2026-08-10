import { describe, expect, it } from "vitest";
import path from "node:path";
import { computeQuarantinePath, QUARANTINE_DIR_NAME } from "./quarantinePath.js";

describe("computeQuarantinePath", () => {
  it("puts the file in a quarantine subfolder of the watched root, keeping its name", () => {
    const result = computeQuarantinePath("/watch", "/watch/secret.txt");
    expect(result).toBe(path.join("/watch", QUARANTINE_DIR_NAME, "secret.txt"));
  });

  it("keeps the original name when there's no collision", () => {
    const result = computeQuarantinePath("/watch", "/watch/nested/dir/report.csv", new Set());
    expect(path.basename(result)).toBe("report.csv");
  });

  it("appends a numeric suffix on collision, preserving the extension", () => {
    const result = computeQuarantinePath("/watch", "/watch/report.csv", new Set(["report.csv"]));
    expect(path.basename(result)).toBe("report (1).csv");
  });

  it("increments the suffix past multiple existing collisions", () => {
    const existing = new Set(["report.csv", "report (1).csv", "report (2).csv"]);
    const result = computeQuarantinePath("/watch", "/watch/report.csv", existing);
    expect(path.basename(result)).toBe("report (3).csv");
  });

  it("handles a file with no extension", () => {
    const result = computeQuarantinePath("/watch", "/watch/README");
    expect(path.basename(result)).toBe("README");
  });
});
