/**
 * The suite TRUNCATEs every table. `pnpm test` loads .env.test, but running
 * vitest any other way (`npx vitest run <file>`) doesn't — and Prisma then
 * silently loads packages/backend/.env on its own, so the truncate hits
 * whatever database *that* points at. It has wiped the dev database once; before
 * dev and prod were split on the deployment host, that file pointed at
 * production. Refuse anything whose database name doesn't end in `_test`.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL;
  let name = "";
  try {
    name = url ? new URL(url).pathname.replace(/^\//, "") : "";
  } catch {
    // fall through to the error below
  }
  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to run backend tests against database "${name || "(DATABASE_URL unset)"}": ` +
        "the suite truncates every table. Run them with `pnpm --filter @logikos-dsp/backend test [file]`, " +
        "which loads .env.test.",
    );
  }
}
