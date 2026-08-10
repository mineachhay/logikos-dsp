import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { RANSOMWARE_RATE_THRESHOLD } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { checkRansomwareRate } from "./ransomwareRate.js";

async function seedAgent() {
  return prisma.agent.create({
    data: {
      key: `agent-${randomUUID()}`,
      hostname: "test-host",
      watchedRoot: "/tmp/test",
    },
  });
}

async function seedFileEvents(agentId: string, count: number) {
  const now = new Date();
  await prisma.fileEvent.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      agentId,
      eventType: "CREATED" as const,
      path: `/tmp/test/file-${i}.txt`,
      occurredAt: now,
    })),
  });
}

describe("checkRansomwareRate", () => {
  it("does not raise an alert below the threshold", async () => {
    const agent = await seedAgent();
    await seedFileEvents(agent.id, RANSOMWARE_RATE_THRESHOLD - 1);

    await checkRansomwareRate(agent.id);

    const alerts = await prisma.alert.findMany({ where: { agentId: agent.id } });
    expect(alerts).toHaveLength(0);
  });

  it("raises a CRITICAL alert with a suggested response action once the threshold is crossed", async () => {
    const agent = await seedAgent();
    await seedFileEvents(agent.id, RANSOMWARE_RATE_THRESHOLD);

    await checkRansomwareRate(agent.id);

    const alerts = await prisma.alert.findMany({
      where: { agentId: agent.id },
      include: { responseActions: true },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("RANSOMWARE_RATE");
    expect(alerts[0].severity).toBe("CRITICAL");
    expect(alerts[0].responseActions).toHaveLength(1);
    expect(alerts[0].responseActions[0].type).toBe("WEBHOOK_NOTIFICATION");
    expect(alerts[0].responseActions[0].status).toBe("PENDING");
  });

  it("does not raise a duplicate alert within the same open window", async () => {
    const agent = await seedAgent();
    await seedFileEvents(agent.id, RANSOMWARE_RATE_THRESHOLD);

    await checkRansomwareRate(agent.id);
    await checkRansomwareRate(agent.id);

    const alerts = await prisma.alert.findMany({ where: { agentId: agent.id } });
    expect(alerts).toHaveLength(1);
  });
});
