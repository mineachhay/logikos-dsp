/**
 * Holds the per-agent secret POST /agents/register issues and recovers from
 * losing it. Kept free of config.ts (which exits the process on missing env at
 * import time) so the retry logic is unit-testable — see agentSession.test.ts.
 *
 * The backend rotates the secret on every registration, so a 401 means one of:
 * another registrant took over this key (e.g. the Go agent), the database was
 * restored from a backup, or the row was cleared. All three are fixed by
 * registering again. A revoked agent gets 403, not 401, and is never retried.
 */

export interface AgentSessionOptions {
  /** Registers with the enroll token and resolves to the new agent secret. */
  register: () => Promise<string>;
  /** Floor between re-registrations, so a persistent 401 can't become a hot loop. */
  minReregisterIntervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export interface AgentSession {
  start(): Promise<void>;
  /** Runs `send` with a bearer header; on a 401, re-registers once and retries. */
  request(send: (authorization: string) => Promise<Response>): Promise<Response>;
}

export function createAgentSession(opts: AgentSessionOptions): AgentSession {
  const minInterval = opts.minReregisterIntervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.error(m));

  let secret: string | null = null;
  let inflight: Promise<void> | null = null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;

  function reregister(): Promise<void> {
    // Concurrent 401s (the event flush and the quarantine poll) share one registration.
    if (!inflight) {
      inflight = opts
        .register()
        .then((s) => {
          secret = s;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    async start() {
      await reregister();
    },

    async request(send) {
      const used = secret;
      const res = await send(`Bearer ${used ?? ""}`);
      if (res.status !== 401) return res;

      if (inflight) {
        await inflight.catch(() => undefined);
      } else if (secret === used) {
        // Nobody has re-registered since this request went out.
        if (now() - lastAttemptAt < minInterval) return res;
        log("agent credentials rejected (401); re-registering");
        lastAttemptAt = now(); // only 401-driven attempts count; startup registration doesn't
        try {
          await reregister();
        } catch (err) {
          log(`re-registration failed: ${err instanceof Error ? err.message : String(err)}`);
          return res;
        }
      }
      if (secret === used) return res;
      return send(`Bearer ${secret}`);
    },
  };
}
