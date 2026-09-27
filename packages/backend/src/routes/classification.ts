import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export async function classificationRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/classification-matches", async (req) => {
    const { limit } = querySchema.parse(req.query);
    const matches = await prisma.classificationMatch.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { classificationJob: { select: { contentScanId: true } } },
    });
    // Which share, and whether discovery found it (an existing file) or a change did.
    const sourceIds = [...new Set(matches.map((m) => m.sourceId).filter((id): id is string => Boolean(id)))];
    const sources = await prisma.source.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, kind: true, rootLabel: true, fileServer: { select: { name: true } } },
    });
    const byId = new Map(sources.map((s) => [s.id, s]));
    return matches.map(({ classificationJob, ...m }) => ({
      ...m,
      source: m.sourceId ? (byId.get(m.sourceId) ?? null) : null,
      foundBy: classificationJob.contentScanId ? "discovery" : "change",
    }));
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
