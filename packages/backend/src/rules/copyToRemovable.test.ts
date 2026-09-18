import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sourceKindFromRoot } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { checkCopyToRemovable } from "./copyToRemovable.js";

async function seedAgent(watchedRoot = "WIN-TEST") {
  const agent = await prisma.agent.create({
    data: { key: `agent-${randomUUID()}`, hostname: "WIN-TEST", watchedRoot },
  });
  const source = await prisma.source.create({
    data: { kind: sourceKindFromRoot("/local"), rootLabel: watchedRoot, agentId: agent.id },
  });
  return { agentId: agent.id, sourceId: source.id };
}

async function seedShare() {
  const source = await prisma.source.create({
    data: { kind: "SMB", rootLabel: "smb://fs/share" },
  });
  return source.id;
}

type Arrival = {
  path: string;
  removable?: boolean;
  volumeLabel?: string | null;
  volumeSerial?: string | null;
  previousSourceId?: string | null;
  actorUser?: string | null;
  eventType?: "CREATED" | "COPIED";
};

async function seedArrivals(agent: { agentId: string; sourceId: string }, arrivals: Arrival[]) {
  for (const arrival of arrivals) {
    await prisma.fileEvent.create({
      data: {
        agentId: agent.agentId,
        sourceId: agent.sourceId,
        eventType: arrival.eventType ?? "COPIED",
        path: arrival.path,
        removable: arrival.removable ?? true,
        volumeLabel: arrival.volumeLabel ?? "KINGSTON",
        volumeSerial: arrival.volumeSerial ?? "1A2B-3C4D",
        previousSourceId: arrival.previousSourceId ?? null,
        actorUser: arrival.actorUser ?? null,
        occurredAt: new Date(),
      },
    });
  }
}

describe("checkCopyToRemovable", () => {
  it("raises nothing when files land on ordinary storage", async () => {
    const agent = await seedAgent();
    await seedArrivals(agent, [{ path: "D:\\work\\report.zip", removable: false, volumeLabel: null, volumeSerial: null }]);

    await checkCopyToRemovable(agent.sourceId);

    expect(await prisma.alert.count({ where: { type: "COPY_TO_REMOVABLE" } })).toBe(0);
  });

  // The case this rule exists for: a file traceable back to a monitored share
  // is now on a device that can leave the building.
  it("raises a HIGH alert for a file copied from a watched share", async () => {
    const agent = await seedAgent();
    const shareId = await seedShare();
    await seedArrivals(agent, [
      { path: "E:\\payroll.csv", previousSourceId: shareId, actorUser: "CORP\\jdoe" },
    ]);

    await checkCopyToRemovable(agent.sourceId);

    const alert = await prisma.alert.findFirstOrThrow({ where: { type: "COPY_TO_REMOVABLE" } });
    expect(alert.severity).toBe("HIGH");
    expect(alert.message).toContain("CORP\\jdoe");
    expect(alert.message).toContain("KINGSTON");
    expect(alert.message).toContain("1A2B-3C4D");
    expect(alert.message).toContain("copied from a monitored share");
  });

  // Someone's own file going onto their own stick is worth recording, not
  // worth treating as an incident.
  it("raises only MEDIUM when nothing ties the file to a share", async () => {
    const agent = await seedAgent();
    await seedArrivals(agent, [{ path: "E:\\holiday.jpg", eventType: "CREATED" }]);

    await checkCopyToRemovable(agent.sourceId);

    const alert = await prisma.alert.findFirstOrThrow({ where: { type: "COPY_TO_REMOVABLE" } });
    expect(alert.severity).toBe("MEDIUM");
  });

  // Copying a folder is one action by a person, and should read as one.
  it("groups a burst into a single alert naming the file count", async () => {
    const agent = await seedAgent();
    const shareId = await seedShare();
    await seedArrivals(
      agent,
      Array.from({ length: 12 }, (_, i) => ({ path: `E:\\HR\\file-${i}.csv`, previousSourceId: shareId })),
    );

    await checkCopyToRemovable(agent.sourceId);
    await checkCopyToRemovable(agent.sourceId); // a second ingest in the same burst

    const alerts = await prisma.alert.findMany({ where: { type: "COPY_TO_REMOVABLE" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("12 file(s)");
  });

  // Two sticks in two ports are two things to ask about, even in one burst.
  it("alerts separately per device", async () => {
    const agent = await seedAgent();
    await seedArrivals(agent, [
      { path: "E:\\a.csv", volumeLabel: "KINGSTON", volumeSerial: "1A2B-3C4D" },
      { path: "F:\\b.csv", volumeLabel: "SANDISK", volumeSerial: "9Z8Y-7X6W" },
    ]);

    await checkCopyToRemovable(agent.sourceId);

    const alerts = await prisma.alert.findMany({ where: { type: "COPY_TO_REMOVABLE" }, orderBy: { message: "asc" } });
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.message).join(" ")).toContain("SANDISK");
    expect(alerts.map((a) => a.message).join(" ")).toContain("KINGSTON");
  });

  // Every alert gets a suggested action, the same approve-first path as the
  // rest of the product.
  it("suggests a notification rather than acting on its own", async () => {
    const agent = await seedAgent();
    await seedArrivals(agent, [{ path: "E:\\payroll.csv" }]);

    await checkCopyToRemovable(agent.sourceId);

    const alert = await prisma.alert.findFirstOrThrow({ where: { type: "COPY_TO_REMOVABLE" } });
    const actions = await prisma.responseAction.findMany({ where: { alertId: alert.id } });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("WEBHOOK_NOTIFICATION");
    expect(actions[0].status).toBe("PENDING");
  });

  it("records the paths, so the alert says what actually went onto the device", async () => {
    const agent = await seedAgent();
    await seedArrivals(agent, [{ path: "E:\\HR\\payroll.csv" }, { path: "E:\\HR\\bonuses.xlsx" }]);

    await checkCopyToRemovable(agent.sourceId);

    const alert = await prisma.alert.findFirstOrThrow({ where: { type: "COPY_TO_REMOVABLE" } });
    const metadata = alert.metadata as { affectedPaths: string[]; volumeSerial: string };
    expect(metadata.affectedPaths).toContain("E:\\HR\\payroll.csv");
    expect(metadata.affectedPaths).toContain("E:\\HR\\bonuses.xlsx");
    expect(metadata.volumeSerial).toBe("1A2B-3C4D");
  });
});
