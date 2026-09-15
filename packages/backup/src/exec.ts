import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs a tool and resolves with its output, or rejects with its stderr. No
 * shell: arguments go straight to the process, so nothing here is a shell
 * injection vector, and secrets travel via env/stdin/config files instead.
 */
export function run(
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          stderr += `\n${command} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`;
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${command}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(opts.stdin ?? "");
  });
}
