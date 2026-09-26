import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { prisma } from "../db.js";
import { SESSION_TTL_SECONDS, allowedWhilePasswordChangeRequired, needsRenewal } from "./sessions.js";
import { loadDirectoryConfig, recheckDirectoryAccount } from "./directoryClient.js";
import { recordSystemAudit } from "../audit.js";

export type Role = "ADMIN" | "VIEWER";

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  /** User.sessionVersion when the token was issued; a mismatch means revoked. */
  sv: number;
  /** Set by the server on each request from the database, never trusted from the token. */
  mustChangePassword?: boolean;
  iat?: number;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: Role) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** Signs a session for `user` and sets it as the cookie. Used by login, renewal and password change. */
export async function issueSession(
  reply: FastifyReply,
  user: { id: string; email: string; role: Role; sessionVersion: number },
): Promise<void> {
  const token = await reply.jwtSign(
    { id: user.id, email: user.email, role: user.role, sv: user.sessionVersion },
    { expiresIn: SESSION_TTL_SECONDS },
  );
  reply.setCookie("token", token, sessionCookieOptions());
}

/**
 * Registers cookie-based JWT auth directly on the root app instance (not via
 * app.register) so the `authenticate`/`requireRole` decorators are visible
 * to every route plugin registered afterward, including the ones that only
 * add a single onRequest hook rather than wrapping every route individually.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required");
  }

  await app.register(cookie);
  await app.register(jwt, {
    secret,
    cookie: { cookieName: "token", signed: false },
  });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify(); // also rejects an expired token
    } catch {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    // The token alone used to be enough, so a deactivated or demoted user kept
    // their access (and role) until they logged out — verified live: a
    // deactivated admin's old cookie still read /users. Now the account is
    // re-read on every request and its current state wins.
    const claims = request.user;
    const user = await prisma.user.findUnique({
      where: { id: claims.id },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        sessionVersion: true,
        mustChangePassword: true,
        source: true,
        directoryGuid: true,
      },
    });
    if (!user || !user.isActive || user.sessionVersion !== claims.sv) {
      reply.clearCookie("token", { path: "/" }).code(401).send({ error: "unauthorized" });
      return;
    }
    request.user = { id: user.id, email: user.email, role: user.role, sv: user.sessionVersion, mustChangePassword: user.mustChangePassword };
    if (user.mustChangePassword && !allowedWhilePasswordChangeRequired(request.method, request.routeOptions.url)) {
      reply.code(403).send({ error: "password change required", code: "PASSWORD_CHANGE_REQUIRED" });
      return;
    }
    // Sliding expiry: an active session is re-issued every RENEW_AFTER_SECONDS.
    if (needsRenewal(claims.iat, Date.now())) {
      if (user.source === "DIRECTORY") {
        const role = await recheckDirectory(user, request);
        if (!role) {
          reply.clearCookie("token", { path: "/" }).code(401).send({ error: "unauthorized" });
          return;
        }
        user.role = role;
        request.user.role = role;
      }
      await issueSession(reply, user);
    }
  });

  app.decorate("requireRole", (role: Role) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.user.role !== role) {
        reply.code(403).send({ error: "forbidden" });
      }
    };
  });
}

/**
 * A directory account's standing is re-read from AD whenever its session is
 * renewed (every RENEW_AFTER_SECONDS of activity), so someone disabled or
 * removed from the groups in AD is out within that, not at token expiry.
 * Returns the current role, or null when the session must end. AD being
 * unreachable keeps the session (the token's own 12h expiry still bounds it)
 * rather than signing everyone out during a DC reboot.
 */
async function recheckDirectory(
  user: { id: string; email: string; role: Role; directoryGuid: string | null },
  request: FastifyRequest,
): Promise<Role | null> {
  const cfg = await loadDirectoryConfig();
  const endAll = async (why: string) => {
    await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
    await recordSystemAudit("active-directory", "user.sessions.revoke", { type: "user", id: user.id }, { email: user.email, reason: why });
    return null;
  };
  if (!cfg || !user.directoryGuid) return endAll("directory sign-in is off");
  const check = await recheckDirectoryAccount(cfg, user.directoryGuid);
  if (check.state === "unavailable") {
    request.log.warn({ detail: check.detail }, "directory re-check skipped: no domain controller answered");
    return user.role;
  }
  if (check.state !== "ok") return endAll(check.state === "gone" ? "account no longer in AD" : check.state === "disabled" ? "disabled in AD" : "not in a mapped AD group");
  if (check.role !== user.role) {
    await recordSystemAudit("active-directory", "user.update", { type: "user", id: user.id }, { email: user.email, role: { from: user.role, to: check.role } });
  }
  await prisma.user.update({ where: { id: user.id }, data: { role: check.role, directoryDn: check.dn, directoryCheckedAt: new Date() } });
  return check.role;
}
