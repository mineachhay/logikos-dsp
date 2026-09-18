import { beforeEach, describe, expect, it } from "vitest";
import { clearAllCredentials, hasCredentials, holdCredentials, takeCredentials } from "./deployCredentials.js";

/**
 * These guard the one property that matters: credentials that install an agent
 * exist in memory, briefly, and are gone once used. If any of this becomes
 * "stored somewhere convenient", this server turns into a domain-wide remote
 * execution tool.
 */
describe("deployment credentials", () => {
  beforeEach(() => clearAllCredentials());

  it("hands credentials over exactly once", () => {
    holdCredentials("d1", { username: "Administrator", password: "hunter2" });

    expect(takeCredentials("d1")).toEqual({ username: "Administrator", password: "hunter2" });
    // A job collected twice would have nothing to run with the second time,
    // which is the point: the backend stops knowing the password.
    expect(takeCredentials("d1")).toBeNull();
  });

  it("forgets them after the window passes", () => {
    const start = 1_000_000;
    holdCredentials("d2", { username: "admin", password: "x" }, start);

    expect(hasCredentials("d2", start + 60_000)).toBe(true);
    expect(hasCredentials("d2", start + 11 * 60 * 1000)).toBe(false);
    expect(takeCredentials("d2", start + 11 * 60 * 1000)).toBeNull();
  });

  it("knows nothing about a job it was never given", () => {
    expect(takeCredentials("never-existed")).toBeNull();
    expect(hasCredentials("never-existed")).toBe(false);
  });

  it("keeps jobs apart", () => {
    holdCredentials("a", { username: "one", password: "1" });
    holdCredentials("b", { username: "two", password: "2" });

    expect(takeCredentials("a")?.username).toBe("one");
    expect(takeCredentials("b")?.username).toBe("two");
  });
});
