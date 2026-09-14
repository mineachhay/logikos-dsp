import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { sendWebhookNotification } from "../responseActions/webhook.js";

const listQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXECUTED", "FAILED"]).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export async function responseActionRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/response-actions", async (req) => {
    const { status, limit } = listQuerySchema.parse(req.query);
    return prisma.responseAction.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { alert: true },
    });
  });

  app.post<{ Params: { id: string } }>(
    "/response-actions/:id/approve",
    { preHandler: app.requireRole("ADMIN") },
    async (req, reply) => {
      const action = await prisma.responseAction.findUnique({
        where: { id: req.params.id },
        include: {
          alert: {
            include: { agent: { select: { hostname: true, watchedRoot: true } }, source: { select: { rootLabel: true } } },
          },
        },
      });
      if (!action) return reply.code(404).send({ error: "response action not found" });
      if (action.status !== "PENDING") {
        return reply.code(409).send({ error: `action already ${action.status.toLowerCase()}` });
      }

      // WEBHOOK_NOTIFICATION executes synchronously right here — the backend
      // can make the HTTP call itself. FILE_QUARANTINE can't: only the agent
      // process has filesystem access to the watched directory, so approval
      // just marks it APPROVED and the agent's next poll
      // (GET /agent-commands) picks it up and reports back via
      // POST /agent-commands/:id/complete, which is what actually sets
      // EXECUTED/FAILED for that action type. See ARCHITECTURE.md.
      if (action.type === "FILE_QUARANTINE") {
        const updated = await prisma.responseAction.update({
          where: { id: action.id },
          data: { status: "APPROVED", approvedByUserId: req.user.id, approvedAt: new Date() },
        });
        return reply.send(updated);
      }

      // Name the share the alert is about, not the agent's own watch root —
      // one agent can scan many shares.
      const { alert } = action;
      const result = await sendWebhookNotification({
        ...alert,
        agent: alert.agent
          ? { hostname: alert.agent.hostname, watchedRoot: alert.source?.rootLabel ?? alert.agent.watchedRoot }
          : null,
      });

      const updated = await prisma.responseAction.update({
        where: { id: action.id },
        data: {
          status: result.ok ? "EXECUTED" : "FAILED",
          approvedByUserId: req.user.id,
          approvedAt: new Date(),
          executedAt: new Date(),
          resultMessage: result.message,
        },
      });
      return reply.send(updated);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/response-actions/:id/reject",
    { preHandler: app.requireRole("ADMIN") },
    async (req, reply) => {
      const action = await prisma.responseAction.findUnique({ where: { id: req.params.id } });
      if (!action) return reply.code(404).send({ error: "response action not found" });
      if (action.status !== "PENDING") {
        return reply.code(409).send({ error: `action already ${action.status.toLowerCase()}` });
      }

      const updated = await prisma.responseAction.update({
        where: { id: action.id },
        data: { status: "REJECTED", approvedByUserId: req.user.id, approvedAt: new Date() },
      });
      return reply.send(updated);
    },
  );
}
