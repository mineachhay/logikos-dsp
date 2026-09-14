import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./credentials.js";

const key = randomBytes(32).toString("base64");

describe("credential encryption", () => {
  it("round-trips, with a fresh IV each time", () => {
    const a = encryptSecret("s3cret pässword", key);
    const b = encryptSecret("s3cret pässword", key);
    expect(a).not.toBe(b);
    expect(a).not.toContain("s3cret");
    expect(decryptSecret(a, key)).toBe("s3cret pässword");
  });

  it("accepts a hex key too", () => {
    const hex = randomBytes(32).toString("hex");
    expect(decryptSecret(encryptSecret("x", hex), hex)).toBe("x");
  });

  it("refuses to decrypt with the wrong key", () => {
    const stored = encryptSecret("x", key);
    expect(() => decryptSecret(stored, randomBytes(32).toString("base64"))).toThrow();
  });

  it("detects tampering", () => {
    const [v, iv, tag, ct] = encryptSecret("hello", key).split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64")].join(":"), key)).toThrow();
  });

  it("rejects a missing or short key", () => {
    expect(() => encryptSecret("x", "")).toThrow(/required/);
    expect(() => encryptSecret("x", randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
