import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "VIEWER"]).default("VIEWER"),
});

const updateUserSchema = z.object({
  role: z.enum(["ADMIN", "VIEWER"]).optional(),
  isActive: z.boolean().optional(),
});

const userSelect = { id: true, email: true, role: true, isActive: true, createdAt: true, lastLoginAt: true } as const;

export async function userRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.requireRole("ADMIN"));

  app.get("/users", async () => {
    return prisma.user.findMany({ select: userSelect, orderBy: { createdAt: "asc" } });
  });

  app.post("/users", async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    try {
      const user = await prisma.user.create({
        data: { email: body.email, passwordHash, role: body.role },
        select: userSelect,
      });
      return reply.code(201).send(user);
    } catch {
      return reply.code(409).send({ error: "a user with that email already exists" });
    }
  });

  app.patch<{ Params: { id: string } }>("/users/:id", async (req, reply) => {
    const body = updateUserSchema.parse(req.body);
    try {
      const user = await prisma.user.update({
        where: { id: req.params.id },
        data: body,
        select: userSelect,
      });
      return reply.send(user);
    } catch {
      return reply.code(404).send({ error: "user not found" });
    }
  });
}
