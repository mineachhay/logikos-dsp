import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Agent } from "@prisma/client";
import { prisma } from "../db.js";

/**
 * Machine authentication for the agent-facing routes — deliberately separate
 * from the user JWT in plugin.ts (see ARCHITECTURE.md, "Agent authentication").
 *
 * Two credentials, both sent as `Authorization: Bearer <token>`:
 * - AGENT_ENROLL_TOKEN, a deployment-wide secret, only on POST /agents/register.
 * - A per-agent secret that register returns, on every other agent route.
 *   Only its sha256 is stored. Plain sha256 rather than bcrypt because it's 32
 *   random bytes, not a human-chosen password — there's nothing to brute-force.
 */

export function generateAgentSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAgentSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time string compare; hashing first makes the lengths equal. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function requireEnrollToken(): string {
  const token = process.env.AGENT_ENROLL_TOKEN;
  if (!token || token.length < 16) {
    throw new Error("AGENT_ENROLL_TOKEN environment variable is required (at least 16 characters)");
  }
  return token;
}

export function isValidEnrollToken(req: FastifyRequest): boolean {
  const provided = bearerToken(req);
  return provided !== null && safeEqual(provided, requireEnrollToken());
}

/**
 * Resolves the agent for `agentKey` and checks the bearer secret against it.
 * Sends 401 (unknown key and wrong secret are indistinguishable on purpose, so
 * the endpoint can't be used to probe which keys exist) or 403 (revoked) and
 * returns null; the caller just returns. Touches lastSeenAt on success.
 */
export async function authenticateAgent(
  req: FastifyRequest,
  reply: FastifyReply,
  agentKey: string,
): Promise<Agent | null> {
  const secret = bearerToken(req);
  const agent = await prisma.agent.findUnique({ where: { key: agentKey } });

  if (agent?.revokedAt) {
    reply.code(403).send({ error: "agent revoked" });
    return null;
  }
  if (!secret || !agent?.secretHash || !safeEqual(hashAgentSecret(secret), agent.secretHash)) {
    reply.code(401).send({ error: "invalid agent credentials" });
    return null;
  }

  return prisma.agent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
}
