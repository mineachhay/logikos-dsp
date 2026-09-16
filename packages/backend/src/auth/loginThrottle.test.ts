import { describe, expect, it } from "vitest";
import { IP_FAILURE_LIMIT, LOCK_AFTER_FAILURES, ipBlockedUntil, lockoutMsFor, secondsUntil } from "./loginThrottle.js";

describe("lockoutMsFor", () => {
  it("allows a few mistyped passwords, then locks for longer and longer", () => {
    expect(lockoutMsFor(LOCK_AFTER_FAILURES - 1)).toBe(0);
    expect(lockoutMsFor(5)).toBe(60_000);
    expect(lockoutMsFor(6)).toBe(300_000);
    expect(lockoutMsFor(7)).toBe(900_000);
  });

  it("caps the backoff instead of locking an account out forever", () => {
    expect(lockoutMsFor(8)).toBe(1_800_000);
    expect(lockoutMsFor(500)).toBe(1_800_000);
  });
});

describe("ipBlockedUntil", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  const failuresAt = (count: number, msAgo: number) => Array.from({ length: count }, () => new Date(now.getTime() - msAgo));

  it("lets normal use through", () => {
    expect(ipBlockedUntil(failuresAt(IP_FAILURE_LIMIT - 1, 1000), now)).toBeNull();
  });

  it("blocks an IP spraying one password across many accounts", () => {
    const until = ipBlockedUntil(failuresAt(IP_FAILURE_LIMIT, 1000), now);
    expect(until).not.toBeNull();
    expect(secondsUntil(until!, now)).toBeGreaterThan(800);
  });

  it("forgets failures older than the window, so an IP recovers by itself", () => {
    expect(ipBlockedUntil(failuresAt(IP_FAILURE_LIMIT + 5, 20 * 60_000), now)).toBeNull();
  });
});

describe("secondsUntil", () => {
  it("never reports zero or negative seconds to wait", () => {
    const now = new Date("2026-09-16T12:00:00Z");
    expect(secondsUntil(new Date(now.getTime() + 30_000), now)).toBe(30);
    expect(secondsUntil(new Date(now.getTime() - 5_000), now)).toBe(1);
  });
});
