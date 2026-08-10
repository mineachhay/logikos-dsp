import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const querySchema = z.object({
  agentId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export async function eventRoutes(app: FastifyInstance) {
  app.get("/events", async (req) => {
    const { agentId, limit } = querySchema.parse(req.query);

    return prisma.fileEvent.findMany({
      where: agentId ? { agentId } : undefined,
      orderBy: { occurredAt: "desc" },
      take: limit,
      include: { agent: { select: { hostname: true, watchedRoot: true } } },
    });
  });
}
