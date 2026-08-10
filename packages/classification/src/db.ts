import pg from "pg";

// Raw `pg` rather than Prisma here: the Prisma client is generated inside
// packages/backend from packages/backend/prisma/schema.prisma, and sharing
// that generated client across a pnpm workspace package boundary needs
// either a custom output path or a dependency on the backend package
// itself. Neither is worth it for a worker that only runs a handful of
// fixed queries against tables Prisma already created — plain SQL against
// the same Postgres-quoted column names Prisma generates keeps the two
// decoupled while still sharing one schema/migration source of truth.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
