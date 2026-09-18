import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PendingDeployment } from "@logikos-dsp/shared";
import { completeDeployment } from "./client.js";

/**
 * Installing the agent on a Windows machine remotely, driven from the
 * dashboard. The work happens in winrm/deploy.py for the same reason activity
 * collection does — NTLM has no maintained Node client.
 *
 * The credentials arrive with the job, are passed to the child on stdin, and
 * are never written anywhere: not to a log line, not to a file, not to the
 * process arguments (where any user on this host could read them out of `ps`).
 */

// See the agent Dockerfile: OpenSSL 3 hides MD4, which NTLM needs.
const OPENSSL_CONF = process.env.ACTIVITY_OPENSSL_CONF ?? "/etc/ssl/openssl-legacy.cnf";

const SCRIPT_PATH =
  process.env.DEPLOY_SCRIPT ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "winrm", "deploy.py");

/** Where the built Windows agent is mounted for the agent to push. */
const INSTALLER_PATH = process.env.AGENT_INSTALLER_PATH ?? "/app/installers/agent.exe";

/** Copying 7MB and installing a service is slower than a poll; give it room. */
const DEPLOY_TIMEOUT_MS = Number(process.env.DEPLOY_TIMEOUT_MS ?? 180_000);

const inFlight = new Set<string>();

interface DeployResult {
  success: boolean;
  message: string;
}

function runDeployer(input: object): Promise<DeployResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SCRIPT_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: existsSync(OPENSSL_CONF) ? { ...process.env, OPENSSL_CONF } : process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), DEPLOY_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`python3 deployer: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        reject(new Error(stderr.trim() || `deployer exited ${code} without output`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as DeployResult);
      } catch {
        reject(new Error(`deployer returned unparseable output: ${stdout.slice(0, 200)}`));
      }
    });
    // stdin, never argv: process arguments are readable by every user on this
    // host, and this payload carries an administrator password.
    child.stdin.end(JSON.stringify(input));
  });
}

export function runDeployments(deployments: readonly PendingDeployment[]): void {
  for (const deployment of deployments) {
    if (inFlight.has(deployment.id)) continue;
    inFlight.add(deployment.id);
    void deployOne(deployment).finally(() => inFlight.delete(deployment.id));
  }
}

async function deployOne(deployment: PendingDeployment): Promise<void> {
  // The address and account, never the password.
  console.log(`deploying agent to ${deployment.address} as ${deployment.username}`);
  try {
    const result = await runDeployer({
      address: deployment.address,
      username: deployment.username,
      password: deployment.password,
      installerPath: INSTALLER_PATH,
      install: deployment.install,
    });
    console.log(`deployment to ${deployment.address}: ${result.success ? "succeeded" : "failed"}`);
    await completeDeployment(deployment.id, result.success, result.message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`deployment to ${deployment.address} failed`, message);
    await completeDeployment(deployment.id, false, message);
  }
}
