import { describe, expect, it } from "vitest";
import { MAX_SAMPLE_UTF8_BYTES, toSample } from "./sampleContent.js";

describe("toSample", () => {
  it("keeps a sample of three-byte text within the backend's 64 KiB of base64, whole characters only", () => {
    const khmer = "សួស្តី".repeat(6000); // 32K+ characters, ~100 KB of UTF-8
    const sample = toSample(khmer);
    expect(sample.length).toBeLessThanOrEqual(64 * 1024);
    const text = Buffer.from(sample, "base64").toString("utf8");
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_SAMPLE_UTF8_BYTES);
    expect(khmer.startsWith(text)).toBe(true);
  });

  it("leaves a short sample alone", () => {
    expect(Buffer.from(toSample("SSN 123-45-6789"), "base64").toString()).toBe("SSN 123-45-6789");
  });
});
