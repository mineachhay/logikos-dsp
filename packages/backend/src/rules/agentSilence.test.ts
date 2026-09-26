import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { checkSilentAgents, SCANNER_SILENT_AFTER_MS } from "./agentSilence.js";

async function agent(capabilities: string[], lastSeenMsAgo: number) {
  return prisma.agent.create({
    data: {
      key: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 6)}`,
      watchedRoot: "/data",
      capabilities,
      lastSeenAt: new Date(Date.now() - lastSeenMsAgo),
    },
  });
}

describe("checkSilentAgents", () => {
  it("raises one HIGH alert per outage for a silent share scanner, with a pending notification", async () => {
    const scanner = await agent(["managed-sources"], SCANNER_SILENT_AFTER_MS + 60_000);
    expect(await checkSilentAgents()).toMatchObject({ raised: 1 });
    expect(await checkSilentAgents()).toMatchObject({ raised: 0 }); // not again while it's open
    const alert = await prisma.alert.findFirstOrThrow({ where: { agentId: scanner.id }, include: { responseActions: true } });
    expect(alert).toMatchObject({ type: "AGENT_SILENT", severity: "HIGH", status: "OPEN" });
    expect(alert.responseActions.map((r) => r.type)).toEqual(["WEBHOOK_NOTIFICATION"]);
  });

  it("resolves the alert once the agent reports again", async () => {
    const scanner = await agent(["managed-sources"], SCANNER_SILENT_AFTER_MS + 60_000);
    await checkSilentAgents();
    await prisma.agent.update({ where: { id: scanner.id }, data: { lastSeenAt: new Date() } });
    expect(await checkSilentAgents()).toMatchObject({ resolved: 1 });
    expect((await prisma.alert.findFirstOrThrow({ where: { agentId: scanner.id } })).status).toBe("RESOLVED");
  });

  it("ignores workstations, revoked agents and agents that are merely a few minutes quiet", async () => {
    const laptop = await agent([], SCANNER_SILENT_AFTER_MS * 10);
    const recent = await agent(["managed-sources"], 60_000);
    const revoked = await agent(["managed-sources"], SCANNER_SILENT_AFTER_MS * 10);
    await prisma.agent.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
    await checkSilentAgents();
    expect(await prisma.alert.count({ where: { agentId: { in: [laptop.id, recent.id, revoked.id] } } })).toBe(0);
  });
});
