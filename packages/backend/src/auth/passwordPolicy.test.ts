import { describe, expect, it } from "vitest";
import { normalizeEmail, passwordProblem } from "./passwordPolicy.js";
import { allowedWhilePasswordChangeRequired, needsRenewal, RENEW_AFTER_SECONDS } from "./sessions.js";

describe("passwordProblem", () => {
  it("accepts a reasonable passphrase", () => {
    expect(passwordProblem("correct horse battery", "jdoe@corp.example")).toBeNull();
  });

  it("rejects short, common, name-containing and one-character passwords", () => {
    expect(passwordProblem("short-pass1", "a@b.c")).toMatch(/at least 12/);
    expect(passwordProblem("Password1234", "a@b.c")).toMatch(/too common/);
    expect(passwordProblem("jdoe-summer-2026", "JDoe@corp.example")).toMatch(/email name/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa", "a@b.c")).toMatch(/more than one or two/);
  });

  it("refuses what bcrypt would silently truncate, counting bytes not characters", () => {
    expect(passwordProblem("abc1".repeat(18), "a@b.c")).toBeNull(); // exactly 72 bytes
    expect(passwordProblem("abc1".repeat(18) + "y", "a@b.c")).toMatch(/at most 72 bytes/);
    expect(passwordProblem("ñ".repeat(37), "a@b.c")).toMatch(/at most 72 bytes/); // 37 chars, 74 bytes
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Admin@Example.COM ")).toBe("admin@example.com");
  });
});

describe("session rules", () => {
  it("renews only once a token is old enough", () => {
    const now = 1_800_000_000_000;
    expect(needsRenewal(now / 1000 - 60, now)).toBe(false);
    expect(needsRenewal(now / 1000 - RENEW_AFTER_SECONDS, now)).toBe(true);
    expect(needsRenewal(undefined, now)).toBe(true);
  });

  it("allows only the password-change routes while a change is required", () => {
    expect(allowedWhilePasswordChangeRequired("POST", "/auth/password")).toBe(true);
    expect(allowedWhilePasswordChangeRequired("GET", "/auth/me")).toBe(true);
    expect(allowedWhilePasswordChangeRequired("GET", "/alerts")).toBe(false);
    expect(allowedWhilePasswordChangeRequired("POST", undefined)).toBe(false);
  });
});
