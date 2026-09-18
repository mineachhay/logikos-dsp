import { describe, expect, it } from "vitest";
import { AGENT_STALE_AFTER_MS, coverageFor, MAX_SCAN_ADDRESSES, parseCidr } from "./discovery.js";

describe("parseCidr", () => {
  it("lists the usable addresses of a /24, without network or broadcast", () => {
    const parsed = parseCidr("20.20.5.0/24");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.addresses).toHaveLength(254);
    expect(parsed.value.addresses[0]).toBe("20.20.5.1");
    expect(parsed.value.addresses.at(-1)).toBe("20.20.5.254");
  });

  it("normalizes an address inside the range to the network it belongs to", () => {
    const parsed = parseCidr("20.20.5.196/24");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cidr).toBe("20.20.5.0/24");
    expect(parsed.value.addresses).toContain("20.20.5.196");
  });

  it("scans exactly one machine for a /32", () => {
    const parsed = parseCidr("20.20.5.196/32");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.addresses).toEqual(["20.20.5.196"]);
  });

  // Sweeping a /16 is minutes of traffic and looks exactly like a port scan to
  // anything watching the network.
  it("refuses a range larger than the cap, and says what to do about it", () => {
    const parsed = parseCidr("20.20.0.0/16");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("65,536");
    expect(parsed.error).toContain(String(MAX_SCAN_ADDRESSES));
    expect(parsed.error).toContain("smaller range");
  });

  it("allows the largest permitted range", () => {
    expect(parseCidr("20.20.0.0/22").ok).toBe(true);
  });

  it("rejects nonsense with a message meant for the person who typed it", () => {
    for (const input of ["", "hello", "20.20.5.0", "20.20.5.0/33", "999.1.1.1/24"]) {
      const parsed = parseCidr(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(10);
    }
  });
});

describe("coverageFor", () => {
  const now = new Date("2026-09-18T10:00:00Z");
  const machine = (address: string, hostname: string | null) => ({ address, hostname, openPorts: [445] });

  it("marks a machine with a live agent as protected", () => {
    const [result] = coverageFor(
      [machine("20.20.5.196", "WIN-FS")],
      [{ hostname: "WIN-FS", lastSeenAt: new Date(now.getTime() - 30_000), revokedAt: null }],
      now,
    );
    expect(result.state).toBe("protected");
  });

  // The mistake this feature must not make: a scan gets the DNS name, the
  // agent registered the short name, and a covered machine is reported as
  // unprotected — sending someone to install an agent that's already there.
  it("matches a fully qualified name against the agent's short one", () => {
    const [result] = coverageFor(
      [machine("20.20.5.196", "win-fs.corp.local")],
      [{ hostname: "WIN-FS", lastSeenAt: now, revokedAt: null }],
      now,
    );
    expect(result.state).toBe("protected");
    expect(result.agentHostname).toBe("WIN-FS");
  });

  it("marks a machine with no agent as unprotected", () => {
    const [result] = coverageFor([machine("20.20.5.10", "LAPTOP-7")], [], now);
    expect(result.state).toBe("unprotected");
    expect(result.agentHostname).toBeNull();
  });

  // A machine whose agent stopped reporting is worse than one known to have
  // none: the dashboard's silence reads as "nothing happened here".
  it("marks a machine whose agent has gone quiet as stale", () => {
    const [result] = coverageFor(
      [machine("20.20.5.196", "WIN-FS")],
      [{ hostname: "WIN-FS", lastSeenAt: new Date(now.getTime() - AGENT_STALE_AFTER_MS - 1000), revokedAt: null }],
      now,
    );
    expect(result.state).toBe("stale");
    expect(result.lastSeenAt).not.toBeNull();
  });

  it("treats a revoked agent as no protection at all", () => {
    const [result] = coverageFor(
      [machine("20.20.5.196", "WIN-FS")],
      [{ hostname: "WIN-FS", lastSeenAt: now, revokedAt: new Date() }],
      now,
    );
    expect(result.state).toBe("unprotected");
  });

  it("uses the most recently seen agent when a machine runs several", () => {
    const [result] = coverageFor(
      [machine("20.20.5.196", "WIN-FS")],
      [
        { hostname: "WIN-FS", lastSeenAt: new Date(now.getTime() - AGENT_STALE_AFTER_MS - 1000), revokedAt: null },
        { hostname: "win-fs", lastSeenAt: now, revokedAt: null },
      ],
      now,
    );
    expect(result.state).toBe("protected");
  });

  it("can't match a machine that never gave a name", () => {
    const [result] = coverageFor([machine("20.20.5.99", null)], [{ hostname: "WIN-FS", lastSeenAt: now, revokedAt: null }], now);
    expect(result.state).toBe("unprotected");
  });
});
