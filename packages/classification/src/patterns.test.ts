import { describe, expect, it } from "vitest";
import { findSensitivePatterns } from "./patterns.js";

function types(content: string): string[] {
  return findSensitivePatterns(content).map((m) => m.patternType);
}

describe("findSensitivePatterns", () => {
  it("detects an SSN in dashed format and redacts all but the last 4 digits", () => {
    const matches = findSensitivePatterns("SSN: 123-45-6789");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ patternType: "ssn", redactedSample: "*****6789" });
  });

  it("does not match a 9-digit number without SSN-style dashes", () => {
    expect(types("account number 123456789")).not.toContain("ssn");
  });

  it("detects a Luhn-valid credit card number", () => {
    const matches = findSensitivePatterns("Card on file: 4111111111111111");
    expect(matches).toHaveLength(1);
    expect(matches[0].patternType).toBe("credit_card");
    expect(matches[0].redactedSample).toBe("************1111");
  });

  it("does not flag a Luhn-invalid number that merely looks like a card", () => {
    // last digit of a known-valid Visa test number, bumped by one to break the checksum
    expect(types("Card on file: 4111111111111112")).not.toContain("credit_card");
  });

  it("detects and redacts an email address", () => {
    const email = "john.doe@example.com";
    const matches = findSensitivePatterns(`Contact: ${email}`);
    expect(matches).toHaveLength(1);
    const expectedStars = "*".repeat("john.doe".length - 1);
    expect(matches[0]).toEqual({ patternType: "email", redactedSample: `j${expectedStars}@example.com` });
  });

  it("detects a phone number", () => {
    expect(types("Call me at 555-123-4567")).toContain("phone");
  });

  it("returns no matches for plain text with no sensitive data", () => {
    expect(findSensitivePatterns("The quick brown fox jumps over the lazy dog.")).toEqual([]);
  });

  it("detects multiple distinct pattern types in one document", () => {
    const content = "SSN: 123-45-6789, email: a@b.com, card: 4111111111111111";
    const found = types(content);
    expect(found).toEqual(expect.arrayContaining(["ssn", "email", "credit_card"]));
  });
});
