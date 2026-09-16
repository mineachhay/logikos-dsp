import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword } from "../auth/passwords.js";
import {
  IP_WINDOW_MS,
  LOCK_AFTER_FAILURES,
  ipBlockedUntil,
  lockoutMsFor,
  secondsUntil,
} from "../auth/loginThrottle.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * One message for every failed login, whatever the reason. Telling a stranger
 * "no such account" or "that account is locked" hands them a list of which
 * accounts exist and which ones they've managed to lock.
 */
const FAILED = { error: "invalid email or password" };

async function recordAttempt(ip: string, email: string, success: boolean): Promise<void> {
  await prisma.loginAttempt.create({ data: { ip, email, success } });
}

/**
 * Raised when an account gets locked, so a login attack is visible where every
 * other alert is — and can be approved through to Telegram. Only on the
 * transition into a lock, not on every subsequent attempt.
 */
async function raiseLoginAttackAlert(email: string, ip: string, failures: number, lockSeconds: number): Promise<void> {
  const alert = await prisma.alert.create({
    data: {
      type: "LOGIN_ATTACK",
      severity: "MEDIUM",
      message: `${failures} failed logins for ${email} (most recently from ${ip}) — the account is locked for ${Math.round(lockSeconds / 60)} minute(s).`,
      metadata: { email, ip, failures },
    },
  });
  await prisma.responseAction.create({ data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" } });
}

function clientIp(req: FastifyRequest): string {
  // trustProxy is on (see app.ts), so this is the real client address behind the gateway.
  return req.ip || "unknown";
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const ip = clientIp(req);
    const now = new Date();

    // 1. Is this IP already guessing too much, across any accounts?
    const recent = await prisma.loginAttempt.findMany({
      where: { ip, success: false, at: { gte: new Date(now.getTime() - IP_WINDOW_MS) } },
      select: { at: true },
    });
    const blockedUntil = ipBlockedUntil(recent.map((r) => r.at), now);
    if (blockedUntil) {
      const seconds = secondsUntil(blockedUntil, now);
      return reply
        .code(429)
        .header("retry-after", String(seconds))
        .send({ error: `too many failed sign-in attempts — try again in ${seconds} seconds` });
    }

    const user = await prisma.user.findUnique({ where: { email: body.email } });

    // 2. Is this account locked? Checked before the password, so a locked
    //    account can't be probed by whether the answer comes back slowly.
    if (user?.lockedUntil && user.lockedUntil > now) {
      await recordAttempt(ip, body.email, false);
      const seconds = secondsUntil(user.lockedUntil, now);
      return reply
        .code(429)
        .header("retry-after", String(seconds))
        .send({ error: `too many failed sign-in attempts — try again in ${seconds} seconds` });
    }

    const ok = Boolean(user) && user!.isActive && (await verifyPassword(body.password, user!.passwordHash));
    if (!ok) {
      await recordAttempt(ip, body.email, false);
      if (user) {
        const failures = user.failedLoginCount + 1;
        const lockMs = lockoutMsFor(failures);
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount: failures, lockedUntil: lockMs ? new Date(now.getTime() + lockMs) : null },
        });
        if (lockMs && failures === LOCK_AFTER_FAILURES) {
          await raiseLoginAttackAlert(user.email, ip, failures, lockMs / 1000);
        }
      }
      return reply.code(401).send(FAILED);
    }

    await recordAttempt(ip, body.email, true);
    await prisma.user.update({
      where: { id: user!.id },
      data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
    });

    const token = await reply.jwtSign({ id: user!.id, email: user!.email, role: user!.role });
    reply
      .setCookie("token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      })
      .send({ id: user!.id, email: user!.email, role: user!.role });
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie("token", { path: "/" }).send({ ok: true });
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (req, reply) => {
    reply.send(req.user);
  });
}
