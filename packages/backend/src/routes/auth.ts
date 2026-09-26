import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { issueSession } from "../auth/plugin.js";
import { normalizeEmail, passwordProblem } from "../auth/passwordPolicy.js";
import { randomBytes } from "node:crypto";
import type { User } from "@prisma/client";
import { recordAudit, recordSystemAudit } from "../audit.js";
import { parseLoginName } from "../auth/directory.js";
import { authenticateDirectory, loadDirectoryConfig } from "../auth/directoryClient.js";
import type { DirectoryConfig } from "../auth/directoryClient.js";
import {
  IP_WINDOW_MS,
  LOCK_AFTER_FAILURES,
  ipBlockedUntil,
  lockoutMsFor,
  secondsUntil,
} from "../auth/loginThrottle.js";

// "email" for API compatibility, but with directory sign-in it's also a
// Windows account name: jdoe, CORP\jdoe or jdoe@corp.example.
const loginSchema = z.object({
  email: z.string().trim().min(1).max(256),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1).max(1024),
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

/** Answers 429 and returns true when this account is in a lockout. */
async function isLocked(user: User | null, ip: string, name: string, now: Date, reply: FastifyReply): Promise<boolean> {
  // Checked before the password, so a locked account can't be probed by
  // whether the answer comes back slowly.
  if (!user?.lockedUntil || user.lockedUntil <= now) return false;
  await recordAttempt(ip, name, false);
  const seconds = secondsUntil(user.lockedUntil, now);
  reply.code(429).header("retry-after", String(seconds)).send({ error: `too many failed sign-in attempts — try again in ${seconds} seconds` });
  return true;
}

async function recordFailure(user: User | null, ip: string, name: string, now: Date): Promise<void> {
  await recordAttempt(ip, name, false);
  if (!user) return;
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

async function completeLogin(user: User, ip: string, name: string, now: Date, reply: FastifyReply) {
  await recordAttempt(ip, name, true);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null } });
  await issueSession(reply, user);
  return reply.send({ id: user.id, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword, source: user.source });
}

/**
 * Sign-in with an Active Directory account. AD checks the password and group
 * membership; here the account is provisioned on first sign-in (matched by
 * objectGUID afterwards) and its role kept in step with its groups.
 */
async function directoryLogin(cfg: DirectoryConfig, name: string, password: string, byEmail: User | null, ip: string, now: Date, reply: FastifyReply) {
  // The local row whose lockout applies: the directory user this name
  // matches, even when typed as a bare username. Failures count against it
  // before they count against the person's AD lockout.
  const parsed = parseLoginName(name);
  const row = byEmail ?? (parsed ? await prisma.user.findFirst({ where: { source: "DIRECTORY", email: `${parsed.sam}@${cfg.domain}`.toLowerCase() } }) : null);
  if (await isLocked(row, ip, name, now, reply)) return reply;

  const result = await authenticateDirectory(cfg, name, password);
  if (!result.ok) {
    if (result.reason === "unavailable") {
      reply.log.warn({ detail: result.detail }, "directory sign-in: no domain controller answered");
      return reply.code(503).send({ error: "Active Directory didn't answer — try again shortly" });
    }
    await recordFailure(row, ip, name, now);
    return reply.code(401).send(FAILED);
  }

  const account = result.account;
  let user = await prisma.user.findUnique({ where: { directoryGuid: account.guid } });
  if (!user) {
    // Never attach an AD account to an existing local one with the same
    // address: that would let whoever controls the AD account take over it.
    if (await prisma.user.findUnique({ where: { email: account.email } })) {
      reply.log.warn({ email: account.email }, "directory sign-in refused: a local account already uses this address");
      await recordAttempt(ip, name, false);
      return reply.code(401).send(FAILED);
    }
    user = await prisma.user.create({
      data: {
        email: account.email,
        role: account.role,
        source: "DIRECTORY",
        directoryGuid: account.guid,
        directoryDn: account.dn,
        directoryCheckedAt: now,
        // Never checked for a directory account; random so it can't be guessed either.
        passwordHash: await hashPassword(randomBytes(32).toString("base64")),
      },
    });
    await recordSystemAudit("active-directory", "user.create", { type: "user", id: user.id }, { email: user.email, role: user.role, source: "DIRECTORY" });
  } else {
    // Deactivated here overrides AD: an admin can still shut someone out.
    if (!user.isActive) {
      await recordAttempt(ip, name, false);
      return reply.code(401).send(FAILED);
    }
    if (await isLocked(user, ip, name, now, reply)) return reply;
    const previousRole = user.role;
    user = await prisma.user.update({
      where: { id: user.id },
      data: { role: account.role, directoryDn: account.dn, directoryCheckedAt: now },
    });
    if (previousRole !== account.role) {
      await recordSystemAudit("active-directory", "user.update", { type: "user", id: user.id }, {
        email: user.email,
        role: { from: previousRole, to: account.role },
      });
    }
  }
  return completeLogin(user, ip, name, now, reply);
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

    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(body.email) } });

    // A local account that matches is always checked locally — so the local
    // admin keeps working when AD is down or misconfigured (break-glass).
    // Anything else goes to Active Directory when directory sign-in is on.
    const directory = !user || user.source === "DIRECTORY" ? await loadDirectoryConfig() : null;
    if (directory) return directoryLogin(directory, body.email, body.password, user, ip, now, reply);

    if (await isLocked(user, ip, body.email, now, reply)) return reply;
    const ok = Boolean(user) && user!.isActive && user!.source === "LOCAL" && (await verifyPassword(body.password, user!.passwordHash));
    if (!ok) {
      await recordFailure(user, ip, body.email, now);
      return reply.code(401).send(FAILED);
    }
    return completeLogin(user!, ip, body.email, now, reply);
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie("token", { path: "/" }).send({ ok: true });
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (req, reply) => {
    const { id, email, role, mustChangePassword } = req.user;
    const { source } = await prisma.user.findUniqueOrThrow({ where: { id }, select: { source: true } });
    reply.send({ id, email, role, mustChangePassword: Boolean(mustChangePassword), source });
  });

  /**
   * Change your own password. Needs the current one, so a session left open
   * on someone's desk can't be turned into a permanent takeover. Ends every
   * other session of this user (sessionVersion bump) and re-issues this one.
   */
  app.post("/auth/password", { preHandler: app.authenticate }, async (req, reply) => {
    const body = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
    if (user.source === "DIRECTORY") {
      return reply.code(400).send({ error: "your password is your Windows password — change it in Windows (Ctrl+Alt+Del → Change a password)" });
    }
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return reply.code(400).send({ error: "current password is incorrect" });
    }
    const problem = passwordProblem(body.newPassword, user.email);
    if (problem) return reply.code(400).send({ error: problem });
    if (await verifyPassword(body.newPassword, user.passwordHash)) {
      return reply.code(400).send({ error: "choose a password different from the current one" });
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        sessionVersion: { increment: 1 },
      },
    });
    await issueSession(reply, updated);
    await recordAudit(req, "user.password.change", { type: "user", id: user.id }, { email: user.email });
    reply.send({ ok: true });
  });
}
