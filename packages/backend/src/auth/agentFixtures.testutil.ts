import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { generateAgentSecret, hashAgentSecret } from "./agentAuth.js";

/** An agent row plus the bearer header its secret produces — what registration would have issued. */
export async function seedAuthedAgent(overrides: { watchedRoot?: string } = {}) {
  const secret = generateAgentSecret();
  const agent = await prisma.agent.create({
    data: {
      key: `agent-${randomUUID()}`,
      hostname: "test-host",
      watchedRoot: overrides.watchedRoot ?? "/tmp/test",
      secretHash: hashAgentSecret(secret),
    },
  });
  return { agent, secret, headers: { authorization: `Bearer ${secret}` } };
}
