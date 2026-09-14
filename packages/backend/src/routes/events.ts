import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const querySchema = z.object({
  agentId: z.string().optional(),
  sourceId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export async function eventRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/events", async (req) => {
    const { agentId, sourceId, limit } = querySchema.parse(req.query);

    return prisma.fileEvent.findMany({
      where: { agentId, sourceId },
      orderBy: { occurredAt: "desc" },
      take: limit,
      include: { agent: { select: { hostname: true, watchedRoot: true } }, source: { select: { id: true, kind: true, rootLabel: true, fileServer: { select: { name: true } } } } },
    });
  });
}
