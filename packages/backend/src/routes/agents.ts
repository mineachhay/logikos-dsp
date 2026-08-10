import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const registerSchema = z.object({
  key: z.string().min(8),
  hostname: z.string().min(1),
  watchedRoot: z.string().min(1),
});

export async function agentRoutes(app: FastifyInstance) {
  // Agents call this on startup to register/refresh themselves before
  // sending events. Idempotent on `key`.
  app.post("/agents/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);

    const agent = await prisma.agent.upsert({
      where: { key: body.key },
      update: {
        hostname: body.hostname,
        watchedRoot: body.watchedRoot,
        lastSeenAt: new Date(),
      },
      create: body,
    });

    return reply.send({ id: agent.id, hostname: agent.hostname, watchedRoot: agent.watchedRoot });
  });

  app.get("/agents", { preHandler: app.authenticate }, async () => {
    return prisma.agent.findMany({ orderBy: { lastSeenAt: "desc" } });
  });
}
