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
export function lockoutMsFor(failures: number): number {
  if (failures < LOCK_AFTER_FAILURES) return 0;
  const step = Math.min(failures - LOCK_AFTER_FAILURES, BACKOFF_MS.length - 1);
  return BACKOFF_MS[step];
}

export function secondsUntil(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

/** Whether this IP has failed too often lately, and for how long it stays blocked. */
export function ipBlockedUntil(recentFailures: readonly Date[], now: Date): Date | null {
  const inWindow = recentFailures.filter((at) => now.getTime() - at.getTime() < IP_WINDOW_MS);
  if (inWindow.length < IP_FAILURE_LIMIT) return null;
  const newest = inWindow.reduce((a, b) => (a > b ? a : b));
  return new Date(newest.getTime() + IP_BLOCK_MS);
}
