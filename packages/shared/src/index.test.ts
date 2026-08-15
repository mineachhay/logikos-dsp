import { describe, expect, it } from "vitest";
import { supportsQuarantine } from "./index.js";

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
