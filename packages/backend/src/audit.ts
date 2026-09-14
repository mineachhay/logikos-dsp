import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

/**
 * Records who changed monitoring configuration. Called from ADMIN routes
 * after the change succeeds. Never put secrets in `details` — record that a
 * password was replaced, not what it is.
 */
export async function recordAudit(
  req: FastifyRequest,
  action: string,
  target: { type: string; id?: string },
  details?: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      userEmail: req.user.email,
      action,
      targetType: target.type,
      targetId: target.id,
      details,
    },
  });
}
