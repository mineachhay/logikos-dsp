import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { TEMP_FILE_WHERE, beforeCursor, ci, listFilters, timeRange } from "./listQuery.js";

const querySchema = z.object({
  agentId: z.string().optional(),
  sourceId: z.string().optional(),
  type: z.enum(["CREATED", "MODIFIED", "DELETED", "RENAMED", "COPIED", "PERMISSION_CHANGED"]).optional(),
  /** Account, as recorded (DOMAIN\user) — contains, any case. */
  user: z.string().trim().max(200).optional(),
  /** A folder or file: the path starts with it, any case. */
  path: z.string().trim().max(1000).optional(),
  /** "1" hides Office lock/save files (~$…, ~WRL….tmp). */
  hideTemp: z.enum(["0", "1"]).default("0"),
  limit: z.coerce.number().int().positive().max(500).default(100),
  ...listFilters,
});

/**
 * Why a change has no "who", so an empty cell isn't read as "nobody":
 * local changes carry no user at all (the OS doesn't report one); a file
 * server's changes only get one from its Windows audit log, which may be off,
 * or may have started after the change.
 */
type NoActorReason = "local" | "audit-off" | "before-audit" | "unmatched";

export async function eventRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/events", async (req) => {
    const q = querySchema.parse(req.query);
    const where: Prisma.FileEventWhereInput = {
      AND: [
        { agentId: q.agentId, sourceId: q.sourceId, eventType: q.type },
        timeRange("occurredAt", q.from, q.to),
        beforeCursor("occurredAt", q.cursor),
        q.user ? { actorUser: ci(q.user) } : {},
        q.path ? { OR: [{ path: { startsWith: q.path, mode: "insensitive" } }, { previousPath: { startsWith: q.path, mode: "insensitive" } }] } : {},
        q.q
          ? { OR: [{ path: ci(q.q) }, { previousPath: ci(q.q) }, { actorUser: ci(q.q) }, { actorHost: ci(q.q) }, { actorIp: ci(q.q) }, { ownerUser: ci(q.q) }] }
          : {},
        q.hideTemp === "1" ? { NOT: TEMP_FILE_WHERE } : {},
      ],
    };

    const events = await prisma.fileEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: q.limit,
      include: {
        agent: { select: { hostname: true, watchedRoot: true } },
        source: { select: { id: true, kind: true, rootLabel: true, fileServerId: true, fileServer: { select: { name: true, activityEnabled: true } } } },
        previousSource: { select: { id: true, kind: true, rootLabel: true, fileServer: { select: { name: true } } } },
      },
    });
    if (events.length === 0) return [];

    // The size before this change: the latest earlier event for the same file that had one.
    const ids = events.filter((e) => e.sizeBytes !== null && e.eventType === "MODIFIED").map((e) => e.id);
    const previous = ids.length
      ? await prisma.$queryRaw<{ id: string; prev: number | null }[]>`
          SELECT e."id", p."sizeBytes" AS prev FROM "FileEvent" e
          JOIN LATERAL (
            SELECT "sizeBytes" FROM "FileEvent" p
            WHERE p."sourceId" = e."sourceId" AND p."path" = e."path" AND p."occurredAt" < e."occurredAt" AND p."sizeBytes" IS NOT NULL
            ORDER BY p."occurredAt" DESC LIMIT 1
          ) p ON true
          WHERE e."id" IN (${Prisma.join(ids)})`
      : [];
    const prevById = new Map(previous.map((p) => [p.id, p.prev]));

    // When each file server's audit records begin.
    const serverIds = [...new Set(events.map((e) => e.source.fileServerId).filter((id): id is string => Boolean(id)))];
    const auditStarts = serverIds.length
      ? await prisma.fileActivity.groupBy({ by: ["fileServerId"], where: { fileServerId: { in: serverIds } }, _min: { occurredAt: true } })
      : [];
    const auditSince = new Map(auditStarts.map((a) => [a.fileServerId, a._min.occurredAt]));

    return events.map(({ source, ...e }) => {
      let noActorReason: NoActorReason | null = null;
      let since: Date | null = null;
      if (!e.actorUser) {
        if (!source.fileServerId) noActorReason = "local";
        else if (!source.fileServer?.activityEnabled) noActorReason = "audit-off";
        else {
          since = auditSince.get(source.fileServerId) ?? null;
          noActorReason = !since || e.occurredAt < since ? "before-audit" : "unmatched";
        }
      }
      return {
        ...e,
        source: { id: source.id, kind: source.kind, rootLabel: source.rootLabel, fileServer: source.fileServer ? { name: source.fileServer.name } : null },
        prevSizeBytes: prevById.get(e.id) ?? null,
        noActorReason,
        auditSince: since,
      };
    });
  });
}
