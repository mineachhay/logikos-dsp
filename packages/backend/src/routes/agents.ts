import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { generateAgentSecret, hashAgentSecret, isValidEnrollToken } from "../auth/agentAuth.js";
import { upsertDefaultSource } from "../sources.js";
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

export async function agentRoutes(app: FastifyInstance) {
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
        secretHash,
        capabilities: body.capabilities,
      },
      create: { ...body, secretHash },
    });
    await upsertDefaultSource(agent);

    return reply.send({ id: agent.id, hostname: agent.hostname, watchedRoot: agent.watchedRoot, agentSecret });
  });

  // Dashboard-facing from here down.
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
