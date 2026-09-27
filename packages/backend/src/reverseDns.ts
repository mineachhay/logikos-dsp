import { promises as dns } from "node:dns";

/**
 * The machine name behind a client IP, from the network's own DNS (in an AD
 * domain, the PTR records DHCP and Windows keep up to date).
 *
 * Looked up when an audit record arrives and stored with it — not when someone
 * views the table: addresses are reassigned, so resolving an old event's IP
 * months later would name whichever PC holds the address now. Cached briefly
 * (a busy server sends the same few IPs every poll) and bounded by a short
 * timeout, so a slow or missing DNS can't hold up ingestion; no answer simply
 * means no name.
 */
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 1500;
const cache = new Map<string, { name: string | null; until: number }>();

export async function hostNameFor(ip: string | null | undefined, now = Date.now()): Promise<string | null> {
  if (!ip) return null;
  const cached = cache.get(ip);
  if (cached && cached.until > now) return cached.name;
  const name = await Promise.race([
    dns.reverse(ip).then((names) => names[0]?.toLowerCase() ?? null, () => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS).unref()),
  ]);
  cache.set(ip, { name, until: now + CACHE_MS });
  return name;
}

/** For tests. */
export function clearHostNameCache(): void {
  cache.clear();
}
