import { z } from "zod";
import type { Prisma } from "@prisma/client";

/**
 * Shared by the long lists (alerts, file events, file access): filters run in
 * Postgres, not over the newest page in the browser — searching "this user"
 * over the last 100 rows looked like an answer and wasn't one — and pages
 * are fetched with a cursor on (time, id), so rows arriving while someone
 * reads never shift or repeat what "Load more" returns.
 */
export const listFilters = {
  q: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** "<ISO time>_<id>" of the last row already shown. */
  cursor: z
    .string()
    .regex(/^[^_]+_[\w-]+$/)
    .optional(),
};

export function parseCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = cursor.split("_") as [string, string];
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : { at, id };
}

/** Rows strictly after the cursor, newest first by `field` then id. */
export function beforeCursor<F extends string>(field: F, cursor: string | undefined) {
  const c = parseCursor(cursor);
  if (!c) return {};
  return { OR: [{ [field]: { lt: c.at } }, { [field]: c.at, id: { lt: c.id } }] };
}

export function timeRange<F extends string>(field: F, from?: Date, to?: Date) {
  if (!from && !to) return {};
  return { [field]: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } };
}

/** What isTemporaryFile (packages/shared) matches, as a Prisma filter. */
export const TEMP_FILE_WHERE: Prisma.FileEventWhereInput = {
  OR: [
    { path: { startsWith: "~" } },
    { path: { contains: "/~" } },
    { path: { contains: "\\~" } },
    { path: { endsWith: ".tmp", mode: "insensitive" } },
  ],
};

const ci = (value: string) => ({ contains: value, mode: "insensitive" as const });
export { ci };
