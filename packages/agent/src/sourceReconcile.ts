import type { ManagedSmbSource } from "@logikos-dsp/shared";

/**
 * Pure planning for managedSources.ts: given the dashboard-managed shares
 * this agent is running and the list GET /agent-sync just returned, what to
 * start, stop, restart, or merely re-time. No config.ts import (it exits the
 * process on missing env), so this is unit-testable.
 */

/**
 * Anything that changes *what* or *how* the agent connects. A change here
 * restarts the scan loop — which resets its baseline, so the first scan
 * after a restart seeds rather than reports. Scan interval is deliberately
 * not part of it: re-timing a loop keeps the baseline.
 */
export function connectionKey(s: ManagedSmbSource): string {
  return JSON.stringify([s.host, s.port ?? null, s.domain ?? null, s.username, s.password, s.share, s.subPath]);
}

export interface RunningSource {
  connectionKey: string;
  scanIntervalSec: number;
}

export interface ReconcilePlan {
  start: ManagedSmbSource[];
  stop: string[];
  retime: ManagedSmbSource[];
}

export function planReconcile(running: ReadonlyMap<string, RunningSource>, desired: readonly ManagedSmbSource[]): ReconcilePlan {
  const plan: ReconcilePlan = { start: [], stop: [], retime: [] };
  const desiredIds = new Set(desired.map((d) => d.id));

  for (const id of running.keys()) {
    if (!desiredIds.has(id)) plan.stop.push(id);
  }
  for (const d of desired) {
    const current = running.get(d.id);
    if (!current) {
      plan.start.push(d);
    } else if (current.connectionKey !== connectionKey(d)) {
      plan.stop.push(d.id);
      plan.start.push(d);
    } else if (current.scanIntervalSec !== d.scanIntervalSec) {
      plan.retime.push(d);
    }
  }
  return plan;
}

/**
 * Caps how many share walks run at once: a full recursive walk of a big share
 * is the expensive part, and a dozen of them starting together on one agent
 * would hammer both the agent and the file servers.
 */
export function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
      active++;
      try {
        return await task();
      } finally {
        active--;
        queue.shift()?.();
      }
    },
    get active() {
      return active;
    },
  };
}

/** Shown in the dashboard as a share's last error / a connection test's result. */
export function describeSmbError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/digital envelope routines|unsupported/i.test(message)) {
    return `${message} — the agent needs NODE_OPTIONS=--openssl-legacy-provider for SMB (NTLM uses DES/MD4)`;
  }
  if (/STATUS_LOGON_FAILURE/.test(message)) return "logon failed — check username, password and domain";
  if (/STATUS_BAD_NETWORK_NAME/.test(message)) return "share not found on that server";
  if (/STATUS_OBJECT_(NAME|PATH)_NOT_FOUND/.test(message)) return "folder not found in that share";
  if (/STATUS_ACCESS_DENIED/.test(message)) return "access denied — the account needs read access to the share";
  if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|timed out/i.test(message)) return `can't reach the server: ${message}`;
  return message;
}
