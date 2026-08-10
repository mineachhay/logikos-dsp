import { describe, expect, it } from "vitest";
import { isSampleable, MAX_SAMPLEABLE_FILE_BYTES } from "./contentSampling.js";

describe("isSampleable", () => {
  it("accepts a textish extension under the size cap", () => {
    expect(isSampleable("notes.txt", 100)).toBe(true);
    expect(isSampleable("data.csv", 100)).toBe(true);
  });

  it("is case-insensitive on extension", () => {
    expect(isSampleable("NOTES.TXT", 100)).toBe(true);
  });

  it("rejects an extension not on the allow-list", () => {
    expect(isSampleable("photo.png", 100)).toBe(false);
    expect(isSampleable("archive.zip", 100)).toBe(false);
  });

  it("rejects a file with no extension", () => {
    expect(isSampleable("README", 100)).toBe(false);
  });

  it("accepts a file exactly at the size cap", () => {
    expect(isSampleable("notes.txt", MAX_SAMPLEABLE_FILE_BYTES)).toBe(true);
  });

  it("rejects a file one byte over the size cap", () => {
    expect(isSampleable("notes.txt", MAX_SAMPLEABLE_FILE_BYTES + 1)).toBe(false);
  });
});
