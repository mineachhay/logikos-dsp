/**
 * Credentials for a remote install, held in memory and nowhere else.
 *
 * An account that can install a service on a workstation is administrator on
 * it. Storing such an account — even encrypted — would make this server worth
 * attacking for its own sake: whoever took it would own every machine it could
 * reach. So a deployment's credentials live here between the moment someone
 * clicks deploy and the moment the agent collects the job, and are dropped as
 * soon as they are handed over.
 *
 * The consequences are deliberate and worth stating plainly:
 *
 *   - A backend restart loses pending credentials, and those deployments fail.
 *     That is better than the alternative.
 *   - Nothing can retry a deployment on its own; someone has to type the
 *     password again, which is exactly the property that makes this safe.
 *   - With several backend instances the agent might poll one that doesn't
 *     hold the job. This deployment runs a single instance; making it
 *     multi-instance means putting this somewhere shared, and that decision
 *     should be taken deliberately rather than discovered.
 */

export interface DeployCredentials {
  username: string;
  password: string;
}

interface Held extends DeployCredentials {
  expiresAt: number;
}

/**
 * How long an uncollected job keeps its credentials. An agent polls every ten
 * seconds, so minutes is already generous — and the longer these sit in
 * memory, the longer a memory disclosure is worth something.
 */
const TTL_MS = 10 * 60 * 1000;

const held = new Map<string, Held>();

export function holdCredentials(deploymentId: string, credentials: DeployCredentials, now = Date.now()): void {
  held.set(deploymentId, { ...credentials, expiresAt: now + TTL_MS });
}

/**
 * Returns the credentials once, removing them. Called when the agent collects
 * the job: after this the backend no longer knows the password, which is the
 * point.
 */
export function takeCredentials(deploymentId: string, now = Date.now()): DeployCredentials | null {
  sweep(now);
  const entry = held.get(deploymentId);
  if (!entry) return null;
  held.delete(deploymentId);
  return { username: entry.username, password: entry.password };
}

/** Whether a job can still be collected — for reporting, without handing anything over. */
export function hasCredentials(deploymentId: string, now = Date.now()): boolean {
  sweep(now);
  return held.has(deploymentId);
}

export function forgetCredentials(deploymentId: string): void {
  held.delete(deploymentId);
}

function sweep(now: number): void {
  for (const [id, entry] of held) {
    if (entry.expiresAt <= now) held.delete(id);
  }
}

/** Tests only: start from a known state. */
export function clearAllCredentials(): void {
  held.clear();
}
