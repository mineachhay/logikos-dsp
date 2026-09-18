import net from "node:net";
import dns from "node:dns/promises";
import type { PendingDiscoveryScan } from "@logikos-dsp/shared";

/**
 * Sweeping a network for machines, so the dashboard can say which of them have
 * no agent.
 *
 * A TCP connect to a handful of ports, not ICMP: ping is blocked by default on
 * a modern Windows firewall while file sharing is open, so pinging would report
 * a room full of machines as absent. It needs no credentials, which is the
 * whole reason discovery comes before any talk of deploying anything.
 */

/** How long to wait for a machine to answer. */
const CONNECT_TIMEOUT_MS = 700;

/**
 * How many addresses to probe at once. High enough to sweep a /24 in a few
 * seconds, low enough not to look like a flood or exhaust file descriptors —
 * the agent is doing its real job at the same time.
 */
const CONCURRENCY = 64;

export interface ScanResult {
  address: string;
  hostname: string | null;
  openPorts: number[];
}

/** Does anything answer on this port? */
function probe(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    // Refused is a real answer — something is there, just not listening here.
    socket.once("error", () => finish(false));
    socket.connect(port, address);
  });
}

async function scanOne(address: string, ports: readonly number[]): Promise<ScanResult | null> {
  const results = await Promise.all(ports.map((port) => probe(address, port)));
  const openPorts = ports.filter((_, index) => results[index]);
  if (openPorts.length === 0) return null;

  // A name is what the coverage report matches against an agent's hostname, so
  // it's worth asking for — but plenty of machines have no reverse DNS, and
  // that is not an error.
  let hostname: string | null = null;
  try {
    const names = await dns.reverse(address);
    hostname = names[0] ?? null;
  } catch {
    hostname = null;
  }
  return { address, hostname, openPorts: [...openPorts] };
}

/**
 * Sweeps the addresses a scan names. Only machines that answered are returned:
 * a list of every dead address in a /24 is noise, and absence is already
 * implied by what isn't there.
 */
export async function runDiscoveryScan(scan: PendingDiscoveryScan): Promise<ScanResult[]> {
  const found: ScanResult[] = [];
  const queue = [...scan.addresses];

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const address = queue.shift();
      if (!address) return;
      const result = await scanOne(address, scan.ports);
      if (result) found.push(result);
    }
  });
  await Promise.all(workers);

  found.sort((a, b) => compareAddresses(a.address, b.address));
  return found;
}

/** Numeric order, so .9 comes before .10 rather than after it. */
function compareAddresses(a: string, b: string): number {
  const toNumber = (address: string) =>
    address.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);
  return toNumber(a) - toNumber(b);
}
