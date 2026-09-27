import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { beforeCursor, ci, listFilters, timeRange } from "./listQuery.js";

const ACTIONS = ["CREATE", "WRITE", "DELETE", "RENAME", "READ", "OTHER"] as const;

const filterSchema = z.object({
  sourceId: z.string().optional(),
  action: z.enum(ACTIONS).optional(),
  /** "DOMAIN\\user" or just "user" — contains, any case. */
  user: z.string().trim().max(200).optional(),
  /** A folder or file: the path starts with it, any case. */
  path: z.string().trim().max(1000).optional(),
  ...listFilters,
});
const querySchema = filterSchema.extend({ limit: z.coerce.number().int().positive().max(500).default(200) });

function whereOf(q: z.infer<typeof filterSchema>): Prisma.FileActivityWhereInput {
  // "DOMAIN\user" is stored as two columns; match either half, or both.
  const [domain, name] = q.user?.includes("\\") ? (q.user.split("\\", 2) as [string, string]) : [null, q.user];
  return {
    AND: [
      { sourceId: q.sourceId, action: q.action },
      timeRange("occurredAt", q.from, q.to),
      beforeCursor("occurredAt", q.cursor),
      name ? { userName: ci(name) } : {},
      domain ? { userDomain: { equals: domain, mode: "insensitive" } } : {},
      q.path ? { path: { startsWith: q.path, mode: "insensitive" } } : {},
      q.q ? { OR: [{ path: ci(q.q) }, { userName: ci(q.q) }, { clientIp: ci(q.q) }, { clientHost: ci(q.q) }] } : {},
    ],
  };
}

/**
 * Who touched what on a Windows share, straight from its audit log — including
 * reads, which no scan can see and which are the only trace of a file being
 * copied *off* the share. Separate from /events, which reports changes.
 */
export async function fileActivityRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/file-activity", async (req) => {
    const q = querySchema.parse(req.query);
    // Explicit fields, not the whole row: recordId is a BigInt (the Windows
    // EventRecordID), which JSON can't serialize — and it's a bookmarking
    // detail nothing outside the collector needs.
    return prisma.fileActivity.findMany({
      where: whereOf(q),
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: q.limit,
      select: {
        id: true,
        path: true,
        action: true,
        userName: true,
        userDomain: true,
        clientIp: true,
        clientHost: true,
        occurredAt: true,
        fileServer: { select: { name: true } },
        source: { select: { id: true, kind: true, rootLabel: true, fileServer: { select: { name: true } } } },
      },
    });
  });

  /**
   * The answer to "what did this person touch" or "who touched this file",
   * over the whole filtered range rather than the rows on screen: counts per
   * action, how many distinct files, the busiest folders and accounts.
   */
  app.get("/file-activity/summary", async (req) => {
    const q = filterSchema.parse(req.query);
    const where = whereOf({ ...q, cursor: undefined });
    const [byAction, first, last, files, users] = await Promise.all([
      prisma.fileActivity.groupBy({ by: ["action"], where, _count: true }),
      prisma.fileActivity.findFirst({ where, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
      prisma.fileActivity.findFirst({ where, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
      prisma.fileActivity.groupBy({ by: ["path"], where, _count: true, orderBy: { _count: { path: "desc" } }, take: 2000 }),
      prisma.fileActivity.groupBy({ by: ["userDomain", "userName"], where, _count: true, orderBy: { _count: { userName: "desc" } }, take: 5 }),
    ]);
    // Folders from the paths, case-insensitively (Windows records whatever case the client used).
    const folders = new Map<string, { folder: string; count: number }>();
    const distinct = new Set<string>();
    for (const f of files) {
      distinct.add(f.path.toLowerCase());
      const folder = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "(top level)";
      const key = folder.toLowerCase();
      const entry = folders.get(key) ?? { folder, count: 0 };
      entry.count += f._count;
      folders.set(key, entry);
    }
    return {
      total: byAction.reduce((n, a) => n + a._count, 0),
      byAction: Object.fromEntries(byAction.map((a) => [a.action, a._count])),
      distinctFiles: distinct.size,
      distinctFilesCapped: files.length >= 2000,
      first: first?.occurredAt ?? null,
      last: last?.occurredAt ?? null,
      topFolders: [...folders.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      topUsers: users.map((u) => ({ user: u.userDomain ? `${u.userDomain}\\${u.userName}` : u.userName, count: u._count })),
    };
  });
}
