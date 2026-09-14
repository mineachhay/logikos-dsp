import { describe, expect, it } from "vitest";
import { normalizeSubPath, smbRootLabel, sourceKindFromRoot, supportsQuarantine } from "./index.js";

describe("supportsQuarantine", () => {
  it("supports a bare filesystem path", () => {
    expect(supportsQuarantine("/mnt/finance")).toBe(true);
  });

  it("excludes an SMB watchedRoot — v9u-smb2's write path is blocked by a hardcoded WRITE_DAC request, see smb.ts", () => {
    expect(supportsQuarantine("smb://fileserver01/finance")).toBe(false);
  });

  it("excludes an M365 watchedRoot — connector only requests read-only Graph scopes", () => {
    expect(supportsQuarantine("m365://b!abc123/Shared/Finance")).toBe(false);
  });

  it("excludes a Google Drive watchedRoot — connector only requests drive.readonly", () => {
    expect(supportsQuarantine("gdrive://1a2b3c4d5e")).toBe(false);
  });

  it("excludes any other scheme-prefixed watchedRoot, not just today's three", () => {
    expect(supportsQuarantine("s3://bucket/prefix")).toBe(false);
  });
});

describe("normalizeSubPath", () => {
  it("canonicalizes separators and trims slashes", () => {
    expect(normalizeSubPath("\\finance\\exports\\")).toBe("finance/exports");
    expect(normalizeSubPath("/a//b/./c/")).toBe("a/b/c");
    expect(normalizeSubPath("")).toBe("");
    expect(normalizeSubPath(undefined)).toBe("");
  });

  it("rejects paths that climb out of the share", () => {
    expect(normalizeSubPath("finance/../../etc")).toBeNull();
    expect(normalizeSubPath("..")).toBeNull();
  });
});

describe("smbRootLabel / sourceKindFromRoot", () => {
  it("formats the share root like SmbSource.describe()", () => {
    expect(smbRootLabel("fs01", "finance", "")).toBe("smb://fs01/finance");
    expect(smbRootLabel("fs01", "finance", "q1/exports")).toBe("smb://fs01/finance/q1/exports");
  });

  it("derives a source kind from a watched root", () => {
    expect(sourceKindFromRoot("/data")).toBe("LOCAL");
    expect(sourceKindFromRoot("smb://fs01/finance")).toBe("SMB");
    expect(sourceKindFromRoot("m365://b!x")).toBe("M365");
    expect(sourceKindFromRoot("gdrive://abc")).toBe("GDRIVE");
  });
});
