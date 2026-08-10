import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export async function classificationRoutes(app: FastifyInstance) {
  app.get("/classification-matches", async (req) => {
    const { limit } = querySchema.parse(req.query);
    return prisma.classificationMatch.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  });

  app.get("/classification-jobs", async (req) => {
    const { limit } = querySchema.parse(req.query);
    return prisma.classificationJob.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { fileEvent: { select: { path: true, agentId: true } }, matches: true },
    });
  });
}
