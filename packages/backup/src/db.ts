import pg from "pg";

// Raw pg, like the classification worker: the backend owns the Prisma schema
// and migrations, and this worker runs a handful of fixed queries against it.
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 3 });
}
