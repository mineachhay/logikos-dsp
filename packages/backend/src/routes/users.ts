import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { normalizeEmail, passwordProblem } from "../auth/passwordPolicy.js";
import { recordAudit } from "../audit.js";

const createUserSchema = z.object({
  email: z.string().email().transform(normalizeEmail),
  password: z.string().min(1).max(1024),
  role: z.enum(["ADMIN", "VIEWER"]).default("VIEWER"),
});

const updateUserSchema = z.object({
  role: z.enum(["ADMIN", "VIEWER"]).optional(),
  isActive: z.boolean().optional(),
});

const resetPasswordSchema = z.object({ newPassword: z.string().min(1).max(1024) });

// Never select passwordHash into a response.
const userSelect = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  lastLoginAt: true,
  failedLoginCount: true,
  lockedUntil: true,
  mustChangePassword: true,
  passwordChangedAt: true,
} as const;

async function findUser(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) reply.code(404).send({ error: "user not found" });
  return user;
}

/**
 * Every user-management change is audited: who made whom an admin, who reset
 * whose password, is exactly the trail a security tool has to keep. (These
 * routes used to record nothing, unlike every other ADMIN route.)
 */
export async function userRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.requireRole("ADMIN"));

  app.get("/users", async () => {
    return prisma.user.findMany({ select: userSelect, orderBy: { createdAt: "asc" } });
  });

  app.post("/users", async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const problem = passwordProblem(body.password, body.email);
    if (problem) return reply.code(400).send({ error: `password: ${problem}` });
    if (await prisma.user.findUnique({ where: { email: body.email } })) {
      return reply.code(409).send({ error: "a user with that email already exists" });
    }
    const user = await prisma.user.create({
      data: { email: body.email, passwordHash: await hashPassword(body.password), role: body.role, passwordChangedAt: new Date() },
      select: userSelect,
    });
    await recordAudit(req, "user.create", { type: "user", id: user.id }, { email: user.email, role: user.role });
    return reply.code(201).send(user);
  });

  app.patch<{ Params: { id: string } }>("/users/:id", async (req, reply) => {
    const body = updateUserSchema.parse(req.body);
    const user = await findUser(req, reply);
    if (!user) return reply;

    const losesAdmin = user.role === "ADMIN" && user.isActive && (body.isActive === false || body.role === "VIEWER");
    if (losesAdmin && user.id === req.user.id) {
      return reply.code(400).send({ error: "you can't deactivate or demote your own account — ask another admin" });
    }
    if (losesAdmin) {
      const otherAdmins = await prisma.user.count({ where: { role: "ADMIN", isActive: true, id: { not: user.id } } });
      if (otherAdmins === 0) return reply.code(409).send({ error: "that would leave no active admin" });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...body,
        // Deactivating ends their sessions now, not at their next login.
        ...(body.isActive === false && user.isActive ? { sessionVersion: { increment: 1 } } : {}),
      },
      select: userSelect,
    });
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (body.role !== undefined && body.role !== user.role) changes.role = { from: user.role, to: body.role };
    if (body.isActive !== undefined && body.isActive !== user.isActive) changes.isActive = { from: user.isActive, to: body.isActive };
    if (Object.keys(changes).length > 0) {
      await recordAudit(req, "user.update", { type: "user", id: user.id }, { email: user.email, ...changes });
    }
    return reply.send(updated);
  });

  /**
   * Admin reset: sets a temporary password the user must change at their next
   * login (enforced server side), and ends their current sessions. Your own
   * password goes through /auth/password, which needs the current one.
   */
  app.post<{ Params: { id: string } }>("/users/:id/password", async (req, reply) => {
    const body = resetPasswordSchema.parse(req.body);
    const user = await findUser(req, reply);
    if (!user) return reply;
    if (user.id === req.user.id) {
      return reply.code(400).send({ error: "change your own password under My account" });
    }
    const problem = passwordProblem(body.newPassword, user.email);
    if (problem) return reply.code(400).send({ error: `password: ${problem}` });
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        sessionVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
      select: userSelect,
    });
    await recordAudit(req, "user.password.reset", { type: "user", id: user.id }, { email: user.email });
    return reply.send(updated);
  });

  /** Clears a login lockout early (it would otherwise expire on its own). */
  app.post<{ Params: { id: string } }>("/users/:id/unlock", async (req, reply) => {
    const user = await findUser(req, reply);
    if (!user) return reply;
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
      select: userSelect,
    });
    await recordAudit(req, "user.unlock", { type: "user", id: user.id }, { email: user.email });
    return reply.send(updated);
  });

  /** Signs the user out everywhere (e.g. a lost laptop). They can log in again. */
  app.post<{ Params: { id: string } }>("/users/:id/sessions/revoke", async (req, reply) => {
    const user = await findUser(req, reply);
    if (!user) return reply;
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
      select: userSelect,
    });
    await recordAudit(req, "user.sessions.revoke", { type: "user", id: user.id }, { email: user.email });
    return reply.send(updated);
  });
}
