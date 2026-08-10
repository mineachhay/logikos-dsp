import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";

export type Role = "ADMIN" | "VIEWER";

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
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
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "unauthorized" });
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
