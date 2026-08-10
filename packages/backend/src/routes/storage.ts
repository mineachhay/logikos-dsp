import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const querySchema = z.object({
  agentId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export async function storageRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/storage", async (req) => {
    const { agentId, limit } = querySchema.parse(req.query);

    const rows = await prisma.storageSnapshot.findMany({
      where: agentId ? { agentId } : undefined,
      orderBy: { takenAt: "desc" },
      take: limit,
      include: { agent: { select: { hostname: true, watchedRoot: true } } },
    });

    // BigInt doesn't serialize through JSON.stringify by default.
    return rows.map((r) => ({ ...r, totalBytes: r.totalBytes.toString() }));
  });
}
