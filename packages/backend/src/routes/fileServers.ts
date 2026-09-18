import type { FastifyInstance, FastifyReply } from "fastify";
import type { Prisma, Source } from "@prisma/client";
import { z } from "zod";
import { MANAGED_SOURCES_CAPABILITY, normalizeSubPath, smbRootLabel } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { encryptSecret } from "@logikos-dsp/shared/credentials";
import { recordAudit } from "../audit.js";

// A connection test the agent hasn't picked up within this long is reported as
// failed rather than spinning forever in the dashboard.
const CONNECTION_TEST_TIMEOUT_MS = 90_000;

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, "hostname or IPv4 address, without smb:// or slashes");
const shareNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\\/:*?"<>|]+$/, "share name only, e.g. finance — put folders in subPath");
const subPathSchema = z
  .string()
  .max(1024)
  .optional()
  .transform((raw, ctx) => {
    const normalized = normalizeSubPath(raw);
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "subPath must stay inside the share (no ..)" });
      return z.NEVER;
    }
    return normalized;
  });

const serverFields = {
  name: z.string().trim().min(1).max(100),
  host: hostSchema,
  port: z.number().int().min(1).max(65535).nullable().optional(),
  domain: z.string().trim().max(100).nullable().optional(),
  username: z.string().trim().min(1).max(256),
};
// "Who changed files": read the Windows Security log over WinRM. Off by
// default; the account may differ from the share account (read-only on the
// share, but a member of Event Log Readers).
const activityFields = {
  activityEnabled: z.boolean().optional(),
  winrmPort: z.number().int().min(1).max(65535).nullable().optional(),
  winrmUsername: z.string().trim().max(256).nullable().optional(),
  winrmPassword: z.string().max(1024).optional(),
  recordReads: z.boolean().optional(),
  bulkReadThreshold: z.number().int().min(2).max(10_000).nullable().optional(),
};

const createServerSchema = z.object({ ...serverFields, ...activityFields, password: z.string().min(1).max(1024) });
const updateServerSchema = z.object({
  name: serverFields.name.optional(),
  host: serverFields.host.optional(),
  port: serverFields.port,
  domain: serverFields.domain,
  username: serverFields.username.optional(),
  // Omitted = keep the stored password. The dashboard never receives it, so it
  // can't round-trip it back.
  password: z.string().min(1).max(1024).optional(),
  ...activityFields,
});

const createShareSchema = z.object({
  shareName: shareNameSchema,
  subPath: subPathSchema,
  scanIntervalSec: z.number().int().min(60).max(86_400).default(300),
  agentId: z.string().uuid(),
});
const updateShareSchema = z.object({
  shareName: shareNameSchema.optional(),
  subPath: subPathSchema,
  scanIntervalSec: z.number().int().min(60).max(86_400).optional(),
  agentId: z.string().uuid().optional(),
});
const connectionTestSchema = z.object({ shareName: shareNameSchema, subPath: subPathSchema, agentId: z.string().uuid() });
const confirmSchema = z.object({ confirm: z.string() });

// Never passwordEnc.
const serverSelect = {
  id: true,
  name: true,
  host: true,
  port: true,
  domain: true,
  username: true,
  enabled: true,
  activityEnabled: true,
  winrmPort: true,
  winrmUsername: true,
  recordReads: true,
  bulkReadThreshold: true,
  lastActivityAt: true,
  lastActivityError: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Never the WinRM password itself — only whether one is stored. */
function withActivityFlags<T extends { winrmUsername: string | null }>(server: T, winrmPasswordEnc: string | null) {
  return { ...server, hasWinrmPassword: Boolean(winrmPasswordEnc) };
}

function serializeShare(s: Source & { agent: { id: string; hostname: string } | null }) {
  return { ...s, lastTotalBytes: s.lastTotalBytes?.toString() ?? null };
}

/** Shares can only go to an agent that exists, isn't revoked, and actually polls /agent-sync. */
async function checkAssignableAgent(agentId: string, reply: FastifyReply): Promise<boolean> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.revokedAt) {
    reply.code(400).send({ error: "agent not found or revoked" });
    return false;
  }
  if (!agent.capabilities.includes(MANAGED_SOURCES_CAPABILITY)) {
    reply.code(400).send({ error: `agent ${agent.hostname} can't scan dashboard-managed shares (the Go agent, or an older build)` });
    return false;
  }
  return true;
}

/**
 * Deleting a server or share deletes the audit history collected from it —
 * events, classification results, snapshots, alerts and their response
 * actions. That's the point of the separate, confirmed Delete (Disable keeps
 * everything). One transaction, children first; FKs are RESTRICT so nothing
 * is left dangling if a step is missed.
 */
export async function deleteSourcesWithHistory(tx: Prisma.TransactionClient, sourceIds: string[]) {
  const alerts = await tx.alert.findMany({ where: { sourceId: { in: sourceIds } }, select: { id: true } });
  const alertIds = alerts.map((a) => a.id);
  await tx.responseAction.deleteMany({ where: { alertId: { in: alertIds } } });
  const deletedAlerts = await tx.alert.deleteMany({ where: { id: { in: alertIds } } });

  const jobFilter = { fileEvent: { sourceId: { in: sourceIds } } };
  await tx.classificationMatch.deleteMany({ where: { classificationJob: jobFilter } });
  await tx.classificationJob.deleteMany({ where: jobFilter });
  const deletedEvents = await tx.fileEvent.deleteMany({ where: { sourceId: { in: sourceIds } } });
  const deletedSnapshots = await tx.storageSnapshot.deleteMany({ where: { sourceId: { in: sourceIds } } });
  await tx.source.deleteMany({ where: { id: { in: sourceIds } } });

  return { fileEvents: deletedEvents.count, storageSnapshots: deletedSnapshots.count, alerts: deletedAlerts.count };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "P2002";
}

export async function fileServerRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);
  const admin = { preHandler: app.requireRole("ADMIN") };

  app.get("/file-servers", admin, async () => {
    const servers = await prisma.fileServer.findMany({
      select: {
        ...serverSelect,
        winrmPasswordEnc: true,
        shares: { include: { agent: { select: { id: true, hostname: true } } }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { name: "asc" },
    });
    return servers.map(({ winrmPasswordEnc, ...s }) => ({ ...withActivityFlags(s, winrmPasswordEnc), shares: s.shares.map(serializeShare) }));
  });

  app.post("/file-servers", admin, async (req, reply) => {
    const body = createServerSchema.parse(req.body);
    try {
      const server = await prisma.fileServer.create({
        data: {
          name: body.name,
          host: body.host,
          port: body.port ?? null,
          domain: body.domain || null,
          username: body.username,
          passwordEnc: encryptSecret(body.password),
          activityEnabled: body.activityEnabled ?? false,
          winrmPort: body.winrmPort ?? null,
          winrmUsername: body.winrmUsername || null,
          winrmPasswordEnc: body.winrmPassword ? encryptSecret(body.winrmPassword) : null,
          recordReads: body.recordReads ?? false,
          bulkReadThreshold: body.bulkReadThreshold ?? null,
        },
        select: serverSelect,
      });
      await recordAudit(req, "fileServer.create", { type: "fileServer", id: server.id }, { name: server.name, host: server.host });
      return reply.code(201).send(server);
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "a file server with that name already exists" });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/file-servers/:id", admin, async (req, reply) => {
    const body = updateServerSchema.parse(req.body);
    const existing = await prisma.fileServer.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: "file server not found" });

    const data: Prisma.FileServerUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.host !== undefined) data.host = body.host;
    if (body.port !== undefined) data.port = body.port;
    if (body.domain !== undefined) data.domain = body.domain || null;
    if (body.username !== undefined) data.username = body.username;
    if (body.password !== undefined) data.passwordEnc = encryptSecret(body.password);
    if (body.activityEnabled !== undefined) data.activityEnabled = body.activityEnabled;
    if (body.winrmPort !== undefined) data.winrmPort = body.winrmPort;
    if (body.recordReads !== undefined) data.recordReads = body.recordReads;
    if (body.bulkReadThreshold !== undefined) data.bulkReadThreshold = body.bulkReadThreshold;
    if (body.winrmUsername !== undefined) data.winrmUsername = body.winrmUsername || null;
    // Blank keeps the stored one, like the share password.
    if (body.winrmPassword) data.winrmPasswordEnc = encryptSecret(body.winrmPassword);
    // Turning collection off clears the error, so a stale message doesn't linger.
    if (body.activityEnabled === false) data.lastActivityError = null;

    try {
      const server = await prisma.$transaction(async (tx) => {
        const updated = await tx.fileServer.update({ where: { id: existing.id }, data, select: serverSelect });
        // Shares display the host in their root label; keep it in step.
        if (body.host !== undefined && body.host !== existing.host) {
          const shares = await tx.source.findMany({ where: { fileServerId: existing.id } });
          for (const share of shares) {
            await tx.source.update({
              where: { id: share.id },
              data: { rootLabel: smbRootLabel(updated.host, share.shareName!, share.subPath) },
            });
          }
        }
        return updated;
      });
      const changed = Object.keys(body).filter((k) => k !== "password" && k !== "winrmPassword");
      await recordAudit(req, "fileServer.update", { type: "fileServer", id: server.id }, {
        name: server.name,
        changed,
        passwordReplaced: body.password !== undefined,
      });
      return server;
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "a file server with that name already exists" });
      throw err;
    }
  });

  for (const [action, enabled] of [["disable", false], ["enable", true]] as const) {
    app.post<{ Params: { id: string } }>(`/file-servers/:id/${action}`, admin, async (req, reply) => {
      const existing = await prisma.fileServer.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: "file server not found" });
      const server = await prisma.fileServer.update({ where: { id: existing.id }, data: { enabled }, select: serverSelect });
      await recordAudit(req, `fileServer.${action}`, { type: "fileServer", id: server.id }, { name: server.name });
      return server;
    });
  }

  app.delete<{ Params: { id: string } }>("/file-servers/:id", admin, async (req, reply) => {
    const { confirm } = confirmSchema.parse(req.query);
    const existing = await prisma.fileServer.findUnique({ where: { id: req.params.id }, include: { shares: true } });
    if (!existing) return reply.code(404).send({ error: "file server not found" });
    if (confirm !== existing.name) {
      return reply.code(400).send({ error: "confirm must equal the file server's name" });
    }
    const deleted = await prisma.$transaction(
      async (tx) => {
        const counts = await deleteSourcesWithHistory(tx, existing.shares.map((s) => s.id));
        await tx.fileServer.delete({ where: { id: existing.id } });
        return counts;
      },
      { timeout: 120_000 },
    );
    await recordAudit(req, "fileServer.delete", { type: "fileServer", id: existing.id }, {
      name: existing.name,
      shares: existing.shares.map((s) => s.rootLabel),
      deleted,
    });
    return { deleted };
  });

  app.post<{ Params: { id: string } }>("/file-servers/:id/shares", admin, async (req, reply) => {
    const body = createShareSchema.parse(req.body);
    const server = await prisma.fileServer.findUnique({ where: { id: req.params.id } });
    if (!server) return reply.code(404).send({ error: "file server not found" });
    if (!(await checkAssignableAgent(body.agentId, reply))) return reply;

    try {
      const share = await prisma.source.create({
        data: {
          kind: "SMB",
          fileServerId: server.id,
          shareName: body.shareName,
          subPath: body.subPath,
          rootLabel: smbRootLabel(server.host, body.shareName, body.subPath),
          scanIntervalSec: body.scanIntervalSec,
          agentId: body.agentId,
        },
        include: { agent: { select: { id: true, hostname: true } } },
      });
      await recordAudit(req, "share.create", { type: "share", id: share.id }, { rootLabel: share.rootLabel, agent: share.agent?.hostname });
      return reply.code(201).send(serializeShare(share));
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "that share and folder are already monitored on this server" });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/shares/:id", admin, async (req, reply) => {
    const body = updateShareSchema.parse(req.body);
    const existing = await prisma.source.findUnique({ where: { id: req.params.id }, include: { fileServer: true } });
    if (!existing || !existing.fileServer) return reply.code(404).send({ error: "share not found" });
    if (body.agentId !== undefined && !(await checkAssignableAgent(body.agentId, reply))) return reply;

    const shareName = body.shareName ?? existing.shareName!;
    // subPath's transform turns "absent" into "" — only treat it as a change if the client sent it.
    const subPath = (req.body as { subPath?: unknown }).subPath === undefined ? existing.subPath : body.subPath;
    try {
      const share = await prisma.source.update({
        where: { id: existing.id },
        data: {
          shareName,
          subPath,
          rootLabel: smbRootLabel(existing.fileServer.host, shareName, subPath),
          scanIntervalSec: body.scanIntervalSec,
          agentId: body.agentId,
        },
        include: { agent: { select: { id: true, hostname: true } } },
      });
      await recordAudit(req, "share.update", { type: "share", id: share.id }, {
        rootLabel: share.rootLabel,
        changed: Object.keys(req.body as object),
      });
      return serializeShare(share);
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "that share and folder are already monitored on this server" });
      throw err;
    }
  });

  for (const [action, enabled] of [["disable", false], ["enable", true]] as const) {
    app.post<{ Params: { id: string } }>(`/shares/:id/${action}`, admin, async (req, reply) => {
      const existing = await prisma.source.findUnique({ where: { id: req.params.id } });
      if (!existing || !existing.fileServerId) return reply.code(404).send({ error: "share not found" });
      const share = await prisma.source.update({
        where: { id: existing.id },
        data: { enabled },
        include: { agent: { select: { id: true, hostname: true } } },
      });
      await recordAudit(req, `share.${action}`, { type: "share", id: share.id }, { rootLabel: share.rootLabel });
      return serializeShare(share);
    });
  }

  app.delete<{ Params: { id: string } }>("/shares/:id", admin, async (req, reply) => {
    const { confirm } = confirmSchema.parse(req.query);
    const existing = await prisma.source.findUnique({ where: { id: req.params.id } });
    if (!existing || !existing.fileServerId) return reply.code(404).send({ error: "share not found" });
    if (confirm !== existing.shareName) {
      return reply.code(400).send({ error: "confirm must equal the share name" });
    }
    const deleted = await prisma.$transaction((tx) => deleteSourcesWithHistory(tx, [existing.id]), { timeout: 120_000 });
    await recordAudit(req, "share.delete", { type: "share", id: existing.id }, { rootLabel: existing.rootLabel, deleted });
    return { deleted };
  });

  app.post<{ Params: { id: string } }>("/file-servers/:id/connection-tests", admin, async (req, reply) => {
    const body = connectionTestSchema.parse(req.body);
    const server = await prisma.fileServer.findUnique({ where: { id: req.params.id } });
    if (!server) return reply.code(404).send({ error: "file server not found" });
    if (!(await checkAssignableAgent(body.agentId, reply))) return reply;

    const test = await prisma.connectionTest.create({
      data: { fileServerId: server.id, agentId: body.agentId, shareName: body.shareName, subPath: body.subPath },
    });
    return reply.code(202).send(test);
  });

  app.get<{ Params: { id: string } }>("/connection-tests/:id", admin, async (req, reply) => {
    let test = await prisma.connectionTest.findUnique({ where: { id: req.params.id } });
    if (!test) return reply.code(404).send({ error: "connection test not found" });
    if (test.status === "PENDING" && Date.now() - test.createdAt.getTime() > CONNECTION_TEST_TIMEOUT_MS) {
      test = await prisma.connectionTest.update({
        where: { id: test.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          message: "the agent didn't pick this up — is it running and connected to the backend?",
        },
      });
    }
    return test;
  });

  app.get("/audit-log", admin, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().positive().max(500).default(50) }).parse(req.query);
    return prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  });
}
