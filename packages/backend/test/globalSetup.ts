import { execSync } from "node:child_process";
import { assertTestDatabase } from "./assertTestDatabase.js";

/**
 * Runs once before the whole suite. Relies on `pnpm test` invoking Node with
 * --env-file=.env.test (see package.json), so DATABASE_URL here is already
 * the test database — `prisma migrate deploy` is non-interactive and
 * idempotent, safe to run on every test invocation.
 */
export async function setup(): Promise<void> {
  assertTestDatabase();
  execSync("npx prisma migrate deploy", {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "inherit",
    env: process.env,
  });
}
