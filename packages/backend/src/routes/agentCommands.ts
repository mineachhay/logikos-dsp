import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const completeSchema = z.object({
  agentKey: z.string().min(8),
  success: z.boolean(),
  message: z.string().min(1),
});

/**
 * Agent-facing: authenticated via Agent.key, not user login — same split as
 * ingest.ts. An agent polls here for FILE_QUARANTINE actions an ADMIN has
 * already approved (via POST /response-actions/:id/approve), then reports
 * back what happened. Never gate these behind app.authenticate.
 */
export async function agentCommandRoutes(app: FastifyInstance) {
  app.get("/agent-commands", async (req, reply) => {
    const { agentKey } = z.object({ agentKey: z.string().min(8) }).parse(req.query);

    const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
    if (!agent) {
      return reply.code(404).send({ error: "unknown agentKey" });
    }

    const actions = await prisma.responseAction.findMany({
      where: { type: "FILE_QUARANTINE", status: "APPROVED", alert: { agentId: agent.id } },
      include: { alert: true },
    });

    const commands = actions
      .map((action) => {
        const metadata = action.alert.metadata as { path?: string } | null;
        return metadata?.path ? { id: action.id, path: metadata.path } : null;
      })
      .filter((c): c is { id: string; path: string } => c !== null);

    return reply.send(commands);
  });

  app.post<{ Params: { id: string } }>("/agent-commands/:id/complete", async (req, reply) => {
    const body = completeSchema.parse(req.body);

    const action = await prisma.responseAction.findUnique({
      where: { id: req.params.id },
      include: { alert: { include: { agent: true } } },
    });
    if (!action || action.alert.agent?.key !== body.agentKey) {
      return reply.code(404).send({ error: "command not found" });
    }

    const updated = await prisma.responseAction.update({
      where: { id: action.id },
      data: {
        status: body.success ? "EXECUTED" : "FAILED",
        executedAt: new Date(),
        resultMessage: body.message,
      },
    });
    return reply.send(updated);
  });
}
