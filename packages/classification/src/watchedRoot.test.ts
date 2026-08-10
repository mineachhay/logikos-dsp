import { describe, expect, it } from "vitest";
import { isLocalWatchedRoot } from "./watchedRoot.js";

describe("isLocalWatchedRoot", () => {
  it("treats a bare filesystem path as local", () => {
    expect(isLocalWatchedRoot("/mnt/finance")).toBe(true);
  });

  it("excludes an SMB watchedRoot", () => {
    expect(isLocalWatchedRoot("smb://fileserver01/finance")).toBe(false);
  });

  it("excludes an M365 watchedRoot", () => {
    expect(isLocalWatchedRoot("m365://b!abc123/Shared/Finance")).toBe(false);
  });

  it("excludes any other scheme-prefixed watchedRoot, not just today's two", () => {
    expect(isLocalWatchedRoot("s3://bucket/prefix")).toBe(false);
  });
});
