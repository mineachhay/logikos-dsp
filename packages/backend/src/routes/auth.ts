import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword } from "../auth/passwords.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.isActive || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid email or password" });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const token = await reply.jwtSign({ id: user.id, email: user.email, role: user.role });
    reply
      .setCookie("token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      })
      .send({ id: user.id, email: user.email, role: user.role });
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie("token", { path: "/" }).send({ ok: true });
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (req, reply) => {
    reply.send(req.user);
  });
}
