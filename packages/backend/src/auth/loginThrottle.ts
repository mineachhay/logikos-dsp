/**
 * Brute-force protection for the dashboard login, which is on the public
 * internet. Two limits, because they stop different attacks: a per-account
 * lockout stops guessing one account's password, and a per-IP limit stops one
 * client spraying a common password across many usernames — which never trips
 * any single account's counter.
 *
 * Pure: the route does the I/O, this decides.
 */

/** Consecutive failures before an account is locked at all. */
export const LOCK_AFTER_FAILURES = 5;

/** Failures from one IP within the window before that IP is throttled. */
export const IP_FAILURE_LIMIT = 20;
export const IP_WINDOW_MS = 15 * 60_000;
export const IP_BLOCK_MS = 15 * 60_000;

// Backoff, not a permanent lock: an admin locked out by someone else's
// guessing gets back in on their own, while an attacker is slowed to a crawl.
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

/** How long to lock an account that has just failed for the `failures`-th time in a row. */
/** `lockAfter` comes from Settings → Security (security.lockAfterFailures). */
export function lockoutMsFor(failures: number, lockAfter = LOCK_AFTER_FAILURES): number {
  if (failures < lockAfter) return 0;
  const step = Math.min(failures - lockAfter, BACKOFF_MS.length - 1);
  return BACKOFF_MS[step];
}

export function secondsUntil(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

/** Whether this IP has failed too often lately, and for how long it stays blocked. */
/** The policy comes from Settings → Security; the defaults are the constants above. */
export function ipBlockedUntil(
  recentFailures: readonly Date[],
  now: Date,
  policy: { limit: number; windowMs: number; blockMs: number } = { limit: IP_FAILURE_LIMIT, windowMs: IP_WINDOW_MS, blockMs: IP_BLOCK_MS },
): Date | null {
  const inWindow = recentFailures.filter((at) => now.getTime() - at.getTime() < policy.windowMs);
  if (inWindow.length < policy.limit) return null;
  const newest = inWindow.reduce((a, b) => (a > b ? a : b));
  return new Date(newest.getTime() + policy.blockMs);
}
