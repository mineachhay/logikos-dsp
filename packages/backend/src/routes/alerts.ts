import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const listQuerySchema = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const updateSchema = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]),
});

export async function alertRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/alerts", async (req) => {
    const { status, limit } = listQuerySchema.parse(req.query);
    return prisma.alert.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { agent: { select: { hostname: true, watchedRoot: true } } },
    });
  });

  app.patch<{ Params: { id: string } }>("/alerts/:id", { preHandler: app.requireRole("ADMIN") }, async (req, reply) => {
    const body = updateSchema.parse(req.body);
    try {
      const alert = await prisma.alert.update({
        where: { id: req.params.id },
        data: { status: body.status },
      });
      return reply.send(alert);
    } catch {
      return reply.code(404).send({ error: "alert not found" });
    }
  });
}
