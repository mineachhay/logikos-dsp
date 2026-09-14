import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { RANSOMWARE_RATE_THRESHOLD, sourceKindFromRoot } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { checkRansomwareRate } from "./ransomwareRate.js";

async function seedAgent(watchedRoot = "/tmp/test") {
  const agent = await prisma.agent.create({
    data: {
      key: `agent-${randomUUID()}`,
      hostname: "test-host",
      watchedRoot,
    },
  });
  const source = await prisma.source.create({
    data: { kind: sourceKindFromRoot(watchedRoot), rootLabel: watchedRoot, agentId: agent.id },
  });
  return { ...agent, sourceId: source.id };
}

async function seedFileEvents(agent: { id: string; sourceId: string }, count: number) {
  const now = new Date();
  await prisma.fileEvent.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      agentId: agent.id,
      sourceId: agent.sourceId,
      eventType: "CREATED" as const,
      path: `/tmp/test/file-${i}.txt`,
      occurredAt: now,
    })),
  });
}

describe("checkRansomwareRate", () => {
  it("does not raise an alert below the threshold", async () => {
    const agent = await seedAgent();
    await seedFileEvents(agent, RANSOMWARE_RATE_THRESHOLD - 1);

    await checkRansomwareRate(agent.sourceId);

    const alerts = await prisma.alert.findMany({ where: { agentId: agent.id } });
    expect(alerts).toHaveLength(0);
  });

  it("raises a CRITICAL alert with webhook + quarantine response actions for a write-capable agent", async () => {
    const agent = await seedAgent("/tmp/test");
    await seedFileEvents(agent, RANSOMWARE_RATE_THRESHOLD);

    await checkRansomwareRate(agent.sourceId);

    const alerts = await prisma.alert.findMany({
      where: { agentId: agent.id },
      include: { responseActions: true },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("RANSOMWARE_RATE");
    expect(alerts[0].severity).toBe("CRITICAL");
    const types = alerts[0].responseActions.map((a) => a.type).sort();
    expect(types).toEqual(["FILE_QUARANTINE", "WEBHOOK_NOTIFICATION"]);
    expect(alerts[0].responseActions.every((a) => a.status === "PENDING")).toBe(true);
    const metadata = alerts[0].metadata as { affectedPaths: string[] };
    expect(metadata.affectedPaths).toHaveLength(RANSOMWARE_RATE_THRESHOLD);
  });

  it("only suggests webhook notification (no quarantine) for a read-only connector like M365", async () => {
    const agent = await seedAgent("m365://b!abc123/Shared/Finance");
    await seedFileEvents(agent, RANSOMWARE_RATE_THRESHOLD);

    await checkRansomwareRate(agent.sourceId);

    const alerts = await prisma.alert.findMany({
      where: { agentId: agent.id },
      include: { responseActions: true },
    });
    expect(alerts[0].responseActions.map((a) => a.type)).toEqual(["WEBHOOK_NOTIFICATION"]);
  });

  it("does not raise a duplicate alert within the same open window", async () => {
    const agent = await seedAgent();
    await seedFileEvents(agent, RANSOMWARE_RATE_THRESHOLD);

    await checkRansomwareRate(agent.sourceId);
    await checkRansomwareRate(agent.sourceId);

    const alerts = await prisma.alert.findMany({ where: { agentId: agent.id } });
    expect(alerts).toHaveLength(1);
  });

  it("counts per source, so two quiet shares on one agent don't add up to a burst", async () => {
    const agent = await seedAgent();
    const share = await prisma.source.create({
      data: { kind: "SMB", rootLabel: "smb://fs01/finance", agentId: agent.id },
    });
    const half = Math.ceil(RANSOMWARE_RATE_THRESHOLD / 2);
    await seedFileEvents(agent, half);
    await seedFileEvents({ id: agent.id, sourceId: share.id }, half);

    await checkRansomwareRate(agent.sourceId);
    await checkRansomwareRate(share.id);

    expect(await prisma.alert.count()).toBe(0);
  });
});
