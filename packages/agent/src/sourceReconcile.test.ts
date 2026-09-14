import { describe, expect, it } from "vitest";
import type { ManagedSmbSource } from "@logikos-dsp/shared";
import { connectionKey, createLimiter, describeSmbError, planReconcile, type RunningSource } from "./sourceReconcile.js";

function share(id: string, overrides: Partial<ManagedSmbSource> = {}): ManagedSmbSource {
  return {
    id,
    kind: "SMB",
    rootLabel: `smb://fs01/${id}`,
    host: "fs01",
    username: "svc",
    password: "pw",
    share: id,
    subPath: "",
    scanIntervalSec: 300,
    ...overrides,
  };
}

function running(...sources: ManagedSmbSource[]): Map<string, RunningSource> {
  return new Map(sources.map((s) => [s.id, { connectionKey: connectionKey(s), scanIntervalSec: s.scanIntervalSec }]));
}

describe("planReconcile", () => {
  it("starts new shares and stops ones no longer assigned", () => {
    const plan = planReconcile(running(share("a"), share("b")), [share("b"), share("c")]);
    expect(plan.start.map((s) => s.id)).toEqual(["c"]);
    expect(plan.stop).toEqual(["a"]);
    expect(plan.retime).toEqual([]);
  });

  it("does nothing when nothing changed", () => {
    expect(planReconcile(running(share("a")), [share("a")])).toEqual({ start: [], stop: [], retime: [] });
  });

  it("restarts a share whose connection details changed, including a replaced password", () => {
    for (const change of [{ password: "new" }, { host: "fs02" }, { subPath: "q1" }, { domain: "CORP" }]) {
      const plan = planReconcile(running(share("a")), [share("a", change)]);
      expect(plan.stop).toEqual(["a"]);
      expect(plan.start.map((s) => s.id)).toEqual(["a"]);
    }
  });

  it("only re-times a share whose interval changed, keeping its baseline", () => {
    const plan = planReconcile(running(share("a")), [share("a", { scanIntervalSec: 60 })]);
    expect(plan).toEqual({ start: [], stop: [], retime: [share("a", { scanIntervalSec: 60 })] });
  });

  it("stops everything when the agent is assigned nothing", () => {
    expect(planReconcile(running(share("a"), share("b")), []).stop.sort()).toEqual(["a", "b"]);
  });
});

describe("createLimiter", () => {
  it("never runs more than max tasks at once, and runs them all", async () => {
    const limiter = createLimiter(2);
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limiter.run(async () => {
          peak = Math.max(peak, limiter.active);
          await new Promise((r) => setTimeout(r, 5));
          done.push(n);
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("releases the slot when a task throws", async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await limiter.run(async () => "next")).toBe("next");
  });
});

describe("describeSmbError", () => {
  it("turns SMB status codes into something an admin can act on", () => {
    expect(describeSmbError(new Error("STATUS_LOGON_FAILURE (0xC000006D)"))).toContain("check username, password");
    expect(describeSmbError(new Error("STATUS_BAD_NETWORK_NAME"))).toBe("share not found on that server");
    expect(describeSmbError(new Error("error:0308010C:digital envelope routines::unsupported"))).toContain("--openssl-legacy-provider");
  });
});
