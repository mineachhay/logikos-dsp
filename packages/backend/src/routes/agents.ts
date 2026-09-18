import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "../db.js";
import { generateAgentSecret, hashAgentSecret, isValidEnrollToken } from "../auth/agentAuth.js";
import { upsertDefaultSource } from "../sources.js";
import { deleteSourcesWithHistory } from "./fileServers.js";
import { recordAudit } from "../audit.js";

const registerSchema = z.object({
  key: z.string().min(8),
  hostname: z.string().min(1),
  watchedRoot: z.string().min(1),
  capabilities: z.array(z.string().max(64)).max(16).default([]),
});

// Never select secretHash into a response.
const agentPublicFields = {
  id: true,
  key: true,
  hostname: true,
  watchedRoot: true,
  createdAt: true,
  lastSeenAt: true,
  revokedAt: true,
  capabilities: true,
} as const;

/**
 * Where the built Windows agent is kept for download. A file on disk rather
 * than something baked into the image, so a new agent build can be dropped in
 * without rebuilding and redeploying the backend — the agent and the backend
 * are deliberately only coupled by the HTTP contract, and this keeps that true
 * for shipping it too.
 */
const INSTALLER_PATH = process.env.AGENT_INSTALLER_PATH ?? "/app/installers/agent.exe";

/**
 * Both of these are ADMIN-only, and deliberately so: the installer is not
 * secret, but the enroll token returned alongside it is the credential that
 * lets a machine register. Handing it to every VIEWER who opens the page would
 * undo the point of having roles.
 */
async function installerInfo(): Promise<{ available: boolean; sizeBytes?: number; sha256?: string; builtAt?: string }> {
  try {
    const info = await stat(INSTALLER_PATH);
    // Shown next to the download so an administrator can check that what
    // landed on the machine is what the server offered.
    const sha256 = createHash("sha256").update(await readFile(INSTALLER_PATH)).digest("hex");
    return { available: true, sizeBytes: info.size, sha256, builtAt: info.mtime.toISOString() };
  } catch {
    return { available: false };
  }
}

export async function agentRoutes(app: FastifyInstance) {
  // What the dashboard needs to show an install command someone can paste.
  app.get(
    "/agents/installer-info",
    { preHandler: [app.authenticate, app.requireRole("ADMIN")] },
    async () => ({ ...(await installerInfo()), enrollToken: process.env.AGENT_ENROLL_TOKEN ?? "" }),
  );

  app.get(
    "/agents/installer",
    { preHandler: [app.authenticate, app.requireRole("ADMIN")] },
    async (_req, reply) => {
      const info = await installerInfo();
      if (!info.available) {
        return reply.code(404).send({ error: "no agent build is available on this server" });
      }
      return reply
        .header("content-type", "application/vnd.microsoft.portable-executable")
        .header("content-disposition", 'attachment; filename="agent.exe"')
        .header("content-length", String(info.sizeBytes))
        .send(createReadStream(INSTALLER_PATH));
    },
  );

  // Agent-facing. Agents call this on startup — and again whenever an ingest
  // call comes back 401 — with AGENT_ENROLL_TOKEN as the bearer. Idempotent on
  // `key`, but every call issues a fresh secret and invalidates the previous
  // one, so agents stay stateless (nothing to persist across restarts) and the
  // most recent registrant for a key is the only one that can send as it.
  app.post("/agents/register", async (req, reply) => {
    if (!isValidEnrollToken(req)) {
      return reply.code(401).send({ error: "invalid enroll token" });
    }
    const body = registerSchema.parse(req.body);

    const existing = await prisma.agent.findUnique({ where: { key: body.key } });
    if (existing?.revokedAt) {
      return reply.code(403).send({ error: "agent revoked" });
    }

    const agentSecret = generateAgentSecret();
    const secretHash = hashAgentSecret(agentSecret);
    const agent = await prisma.agent.upsert({
      where: { key: body.key },
      update: {
        hostname: body.hostname,
        watchedRoot: body.watchedRoot,
        lastSeenAt: new Date(),
        lastIp: req.ip,
        secretHash,
        capabilities: body.capabilities,
      },
      create: { ...body, secretHash, lastIp: req.ip },
    });
    await upsertDefaultSource(agent);

    return reply.send({ id: agent.id, hostname: agent.hostname, watchedRoot: agent.watchedRoot, agentSecret });
  });

  // Dashboard-facing from here down.
  /**
   * Removing an agent for good, with the history it collected.
   *
   * Only a revoked agent: a running one would simply register again on its
   * next request, leaving a row that reappears seconds after someone deleted
   * it — and revoking first forces the decision to be made twice, which is
   * appropriate for something that destroys audit history.
   *
   * Shares the agent was *assigned* are not touched. Those belong to a file
   * server, not to whoever happened to be scanning them, and their history
   * outlives any one agent — they are simply unassigned, and the dashboard
   * can hand them to another agent.
   */
  app.delete<{ Params: { id: string } }>(
    "/agents/:id",
    { preHandler: [app.authenticate, app.requireRole("ADMIN")] },
    async (req, reply) => {
      const agent = await prisma.agent.findUnique({
        where: { id: req.params.id },
        include: { sources: true },
      });
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      if (!agent.revokedAt) {
        return reply.code(400).send({ error: "revoke the agent first — a running agent would just register again" });
      }

      const ownSourceIds = agent.sources.filter((s) => s.fileServerId === null).map((s) => s.id);
      const assignedShareIds = agent.sources.filter((s) => s.fileServerId !== null).map((s) => s.id);

      // Events this agent reported *for a share* belong to the share, not to
      // the agent, and must survive it. FileEvent.agentId is required, so
      // those rows can't simply be reassigned — refuse rather than quietly
      // delete a file server's history along with a stale agent row.
      const shareEvents = await prisma.fileEvent.count({
        where: { agentId: agent.id, sourceId: { in: assignedShareIds } },
      });
      if (shareEvents > 0) {
        return reply.code(409).send({
          error: `${agent.hostname} reported ${shareEvents} event(s) for shares it was assigned. Deleting it would take that history with it — reassign those shares and delete the server's history instead, if that's what you want.`,
        });
      }

      const deleted = await prisma.$transaction(
        async (tx) => {
          await tx.source.updateMany({ where: { id: { in: assignedShareIds } }, data: { agentId: null } });
          await tx.connectionTest.deleteMany({ where: { agentId: agent.id } });
          await tx.discoveryScan.deleteMany({ where: { agentId: agent.id } });
          await tx.deployment.deleteMany({ where: { agentId: agent.id } });
          const counts = await deleteSourcesWithHistory(tx, ownSourceIds);
          // Anything left hanging off the agent rather than a source.
          const alerts = await tx.alert.findMany({ where: { agentId: agent.id }, select: { id: true } });
          await tx.responseAction.deleteMany({ where: { alertId: { in: alerts.map((a) => a.id) } } });
          await tx.alert.deleteMany({ where: { id: { in: alerts.map((a) => a.id) } } });
          await tx.storageSnapshot.deleteMany({ where: { agentId: agent.id } });
          await tx.agent.delete({ where: { id: agent.id } });
          return counts;
        },
        { timeout: 120_000 },
      );

      await recordAudit(req, "agent.delete", { type: "Agent", id: agent.id }, {
        hostname: agent.hostname,
        watchedRoot: agent.watchedRoot,
        unassignedShares: assignedShareIds.length,
        deleted,
      });
      return reply.send({ deleted });
    },
  );

  app.get("/agents", { preHandler: app.authenticate }, async () => {
    return prisma.agent.findMany({ select: agentPublicFields, orderBy: { lastSeenAt: "desc" } });
  });

  // Revoking clears the secret, so a running agent is cut off at its next
  // request, and blocks re-registration even with the enroll token.
  app.post<{ Params: { id: string } }>(
    "/agents/:id/revoke",
    { preHandler: [app.authenticate, app.requireRole("ADMIN")] },
    async (req, reply) => {
      const found = await prisma.agent.findUnique({ where: { id: req.params.id } });
      if (!found) return reply.code(404).send({ error: "agent not found" });
      const updated = await prisma.agent.update({
        where: { id: found.id },
        data: { revokedAt: new Date(), secretHash: null },
        select: agentPublicFields,
      });
      await recordAudit(req, "agent.revoke", { type: "agent", id: found.id }, { hostname: found.hostname });
      return updated;
    },
  );

  // Restoring only lifts the block; the agent gets a new secret the next time
  // it registers (on restart, or automatically on its next 401).
  app.post<{ Params: { id: string } }>(
    "/agents/:id/restore",
    { preHandler: [app.authenticate, app.requireRole("ADMIN")] },
    async (req, reply) => {
      const found = await prisma.agent.findUnique({ where: { id: req.params.id } });
      if (!found) return reply.code(404).send({ error: "agent not found" });
      const updated = await prisma.agent.update({ where: { id: found.id }, data: { revokedAt: null }, select: agentPublicFields });
      await recordAudit(req, "agent.restore", { type: "agent", id: found.id }, { hostname: found.hostname });
      return updated;
    },
  );
}
