import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Alert, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { recordAudit } from "../audit.js";
import { beforeCursor, ci, listFilters, timeRange } from "./listQuery.js";

const STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const listQuerySchema = z.object({
  /** One status, or several comma-separated ("OPEN,ACKNOWLEDGED" — the page's default). */
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",") : undefined))
    .pipe(z.array(z.enum(STATUSES)).optional()),
  severity: z.enum(SEVERITIES).optional(),
  type: z.string().regex(/^[A-Z_]+$/).optional(),
  sourceId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  ...listFilters,
});

const updateSchema = z.object({
  status: z.enum(STATUSES),
  /** Why — "false positive: Excel autosave". Kept on the alert and in the audit log. */
  note: z.string().trim().max(1000).optional(),
});
const bulkSchema = updateSchema.extend({ ids: z.array(z.string().uuid()).min(1).max(500) });

const include = {
  agent: { select: { hostname: true, watchedRoot: true } },
  source: { select: { id: true, kind: true, rootLabel: true, fileServer: { select: { name: true } } } },
  responseActions: true,
} satisfies Prisma.AlertInclude;

/** The fields a status change sets: who and when, per step, and the note. */
function transition(alert: Pick<Alert, "status" | "acknowledgedAt">, status: (typeof STATUSES)[number], email: string, note?: string): Prisma.AlertUpdateInput {
  const now = new Date();
  const data: Prisma.AlertUpdateInput = { status };
  if (status === "ACKNOWLEDGED") Object.assign(data, { acknowledgedAt: now, acknowledgedByEmail: email });
  if (status === "RESOLVED") {
    Object.assign(data, { resolvedAt: now, resolvedByEmail: email });
    // Resolving straight from OPEN also means someone looked at it.
    if (!alert.acknowledgedAt) Object.assign(data, { acknowledgedAt: now, acknowledgedByEmail: email });
  }
  if (status === "OPEN") Object.assign(data, { resolvedAt: null, resolvedByEmail: null });
  if (note) data.note = note;
  return data;
}

async function changeStatus(req: FastifyRequest, ids: string[], status: (typeof STATUSES)[number], note?: string) {
  const alerts = await prisma.alert.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, acknowledgedAt: true, type: true } });
  for (const alert of alerts) {
    if (alert.status === status && !note) continue;
    await prisma.alert.update({ where: { id: alert.id }, data: transition(alert, status, req.user.email, note) });
    await recordAudit(req, `alert.${status.toLowerCase()}`, { type: "alert", id: alert.id }, { from: alert.status, to: status, type: alert.type, ...(note ? { note } : {}) });
  }
  return alerts.map((a) => a.id);
}

/** What an alert is about, as rows: the changes of a burst, the reads of a bulk copy, the files put on a USB device. */
async function relatedRows(alert: Alert) {
  const meta = (alert.metadata ?? {}) as Record<string, unknown>;
  const windowMs = Number(meta.windowSeconds ?? 300) * 1000;
  const around = { gte: new Date(alert.createdAt.getTime() - windowMs - 60_000), lte: new Date(alert.createdAt.getTime() + 60_000) };
  const paths = Array.isArray(meta.affectedPaths) ? (meta.affectedPaths as string[]) : typeof meta.path === "string" ? [meta.path] : [];

  if (alert.type === "BULK_FILE_READ" && typeof meta.userName === "string" && alert.sourceId) {
    const rows = await prisma.fileActivity.findMany({
      where: { sourceId: alert.sourceId, userName: meta.userName, action: "READ", occurredAt: around },
      orderBy: { occurredAt: "desc" },
      take: 200,
      select: { id: true, path: true, action: true, userName: true, userDomain: true, clientIp: true, clientHost: true, occurredAt: true },
    });
    return { kind: "activity" as const, rows };
  }
  if (paths.length && alert.sourceId) {
    const rows = await prisma.fileEvent.findMany({
      where: {
        sourceId: alert.sourceId,
        path: { in: paths },
        // A sensitive-data finding points at a file whatever its age; the others at a burst.
        ...(alert.type === "SENSITIVE_DATA_EXPOSED" ? {} : { occurredAt: around }),
      },
      orderBy: { occurredAt: "desc" },
      take: 200,
      select: { id: true, eventType: true, path: true, previousPath: true, sizeBytes: true, actorUser: true, actorHost: true, actorIp: true, occurredAt: true },
    });
    return { kind: "events" as const, rows, paths };
  }
  return null;
}

export async function alertRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/alerts", async (req) => {
    const q = listQuerySchema.parse(req.query);
    return prisma.alert.findMany({
      where: {
        AND: [
          q.status ? { status: { in: q.status } } : {},
          { severity: q.severity, sourceId: q.sourceId, ...(q.type ? { type: q.type as Alert["type"] } : {}) },
          timeRange("createdAt", q.from, q.to),
          beforeCursor("createdAt", q.cursor),
          q.q ? { OR: [{ message: ci(q.q) }, { note: ci(q.q) }, { source: { rootLabel: ci(q.q) } }] } : {},
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit,
      include,
    });
  });

  /** One alert with everything needed to decide on it: the files involved and its history. */
  app.get<{ Params: { id: string } }>("/alerts/:id", async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: "alert not found" });
    const alert = await prisma.alert.findUnique({ where: { id: req.params.id }, include });
    if (!alert) return reply.code(404).send({ error: "alert not found" });
    const [history, related] = await Promise.all([
      prisma.auditLog.findMany({ where: { targetType: "alert", targetId: alert.id }, orderBy: { createdAt: "asc" } }),
      relatedRows(alert),
    ]);
    // Approvals and rejections are audited against the action, not the alert.
    const actionIds = alert.responseActions.map((a) => a.id);
    const actionHistory = actionIds.length
      ? await prisma.auditLog.findMany({ where: { targetType: "responseAction", targetId: { in: actionIds } }, orderBy: { createdAt: "asc" } })
      : [];
    return {
      ...alert,
      history: [...history, ...actionHistory].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      related,
    };
  });

  app.patch<{ Params: { id: string } }>("/alerts/:id", { preHandler: app.requireRole("ADMIN") }, async (req, reply) => {
    const body = updateSchema.parse(req.body);
    const changed = await changeStatus(req, [req.params.id], body.status, body.note).catch(() => []);
    if (changed.length === 0) return reply.code(404).send({ error: "alert not found" });
    return reply.send(await prisma.alert.findUnique({ where: { id: req.params.id } }));
  });

  /** Several at once — acknowledging a morning's worth of alerts one click at a time is how they stop being read. */
  app.post("/alerts/bulk", { preHandler: app.requireRole("ADMIN") }, async (req) => {
    const body = bulkSchema.parse(req.body);
    const updated = await changeStatus(req, body.ids, body.status, body.note);
    return { updated: updated.length };
  });
}
