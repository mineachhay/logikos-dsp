import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const querySchema = z.object({
  sourceId: z.string().optional(),
  action: z.enum(["CREATE", "WRITE", "DELETE", "RENAME", "READ", "OTHER"]).optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

/**
 * Who touched what on a Windows share, straight from its audit log — including
 * reads, which no scan can see and which are the only trace of a file being
 * copied *off* the share. Separate from /events, which reports changes.
 */
export async function fileActivityRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/file-activity", async (req) => {
    const { sourceId, action, limit } = querySchema.parse(req.query);
    return prisma.fileActivity.findMany({
      where: { sourceId, action },
      orderBy: { occurredAt: "desc" },
      take: limit,
      include: {
        fileServer: { select: { name: true } },
        source: { select: { id: true, kind: true, rootLabel: true, fileServer: { select: { name: true } } } },
      },
    });
  });
}
