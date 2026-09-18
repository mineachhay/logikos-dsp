/**
 * Network discovery: what to scan, and what a found machine means.
 *
 * Pure, because the interesting parts are decisions rather than I/O — how big
 * a range someone is allowed to sweep, and whether a machine that answered is
 * one we already have an agent on. The scanning itself lives in the agent.
 */

/** Ports that make a host look like a Windows machine worth deploying to. */
export const DISCOVERY_PORTS = [445, 3389, 5985] as const;

/**
 * The largest range a single scan may cover. A /16 is 65,536 addresses, which
 * is minutes of traffic and looks exactly like a port sweep to anything
 * watching the network — and nobody deploys agents to 65,000 machines from one
 * button. /22 (1,024 addresses) covers any realistic office subnet.
 */
export const MAX_SCAN_ADDRESSES = 1024;

export interface ParsedCidr {
  /** Every address in the range, excluding network and broadcast. */
  addresses: string[];
  /** What was parsed, normalized: "20.20.5.0/24". */
  cidr: string;
}

/**
 * Parses and bounds a CIDR. Returns an error message rather than throwing,
 * because every caller wants to show it to the person who typed it.
 */
export function parseCidr(input: string): { ok: true; value: ParsedCidr } | { ok: false; error: string } {
  const trimmed = input.trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(trimmed);
  if (!match) {
    return { ok: false, error: `"${trimmed}" is not a network range — expected something like 20.20.5.0/24` };
  }

  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  if (octets.some((octet) => octet > 255)) {
    return { ok: false, error: `"${trimmed}" has an octet above 255` };
  }
  const prefix = Number(match[5]);
  if (prefix < 8 || prefix > 32) {
    return { ok: false, error: "the prefix must be between /8 and /32" };
  }

  const size = 2 ** (32 - prefix);
  if (size > MAX_SCAN_ADDRESSES) {
    return {
      ok: false,
      error: `/${prefix} covers ${size.toLocaleString()} addresses; ${MAX_SCAN_ADDRESSES} is the most one scan may sweep. Scan a smaller range.`,
    };
  }

  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const network = prefix === 32 ? base : (base & (0xffffffff << (32 - prefix))) >>> 0;

  const addresses: string[] = [];
  for (let offset = 0; offset < size; offset++) {
    // Skip the network and broadcast addresses, which never answer — unless
    // the range is a single host or a pair, where they're the point.
    if (size > 2 && (offset === 0 || offset === size - 1)) continue;
    addresses.push(toDottedQuad((network + offset) >>> 0));
  }

  return { ok: true, value: { addresses, cidr: `${toDottedQuad(network)}/${prefix}` } };
}

function toDottedQuad(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export interface DiscoveredMachine {
  address: string;
  hostname: string | null;
  openPorts: number[];
}

export interface KnownAgent {
  hostname: string;
  lastSeenAt: Date;
  revokedAt: Date | null;
  /** The address the agent last called in from, when the backend recorded one. */
  lastIp?: string | null;
}

export type CoverageState = "protected" | "stale" | "unprotected";

export interface Coverage extends DiscoveredMachine {
  state: CoverageState;
  agentHostname: string | null;
  lastSeenAt: Date | null;
}

/**
 * How long an agent may go quiet before its machine counts as uncovered. An
 * agent reports at least once a minute, so an hour is far past "busy" and
 * firmly into "stopped" — and a machine nobody knows has stopped reporting is
 * worse than one known to have no agent, because the dashboard's silence
 * reads as "nothing happened here".
 */
export const AGENT_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Joins what the scan found to the agents that have registered.
 *
 * By address first, then hostname. The address is the reliable half: a scan
 * always learns it, while a name depends on reverse DNS, which a workgroup has
 * no records for at all — the first real scan came back with two machines, no
 * names, and an agent-bearing server reported as unprotected.
 *
 * Hostname matching remains for the case where an agent has never called in
 * from the address that answered (a second NIC, a machine behind NAT), and
 * compares only the first label, case-insensitively: a scan gets
 * "win-fs.corp.local" while the agent registered "WIN-FS". Treating those as
 * different machines would report a covered machine as unprotected, which is
 * the one mistake this whole feature must not make.
 */
export function coverageFor(
  machines: readonly DiscoveredMachine[],
  agents: readonly KnownAgent[],
  now = new Date(),
): Coverage[] {
  const byHost = new Map<string, KnownAgent>();
  const byAddress = new Map<string, KnownAgent>();
  const remember = (map: Map<string, KnownAgent>, key: string, agent: KnownAgent) => {
    const existing = map.get(key);
    // Several agents can share a machine; the most recently seen decides.
    if (!existing || agent.lastSeenAt > existing.lastSeenAt) map.set(key, agent);
  };
  for (const agent of agents) {
    remember(byHost, shortHostname(agent.hostname), agent);
    if (agent.lastIp) remember(byAddress, agent.lastIp, agent);
  }

  return machines.map((machine) => {
    const agent =
      byAddress.get(machine.address) ?? (machine.hostname ? byHost.get(shortHostname(machine.hostname)) : undefined);
    if (!agent || agent.revokedAt) {
      return { ...machine, state: "unprotected", agentHostname: agent?.hostname ?? null, lastSeenAt: agent?.lastSeenAt ?? null };
    }
    const quiet = now.getTime() - agent.lastSeenAt.getTime() > AGENT_STALE_AFTER_MS;
    return {
      ...machine,
      state: quiet ? "stale" : "protected",
      agentHostname: agent.hostname,
      lastSeenAt: agent.lastSeenAt,
    };
  });
}

function shortHostname(hostname: string): string {
  return hostname.trim().toLowerCase().split(".")[0];
}
