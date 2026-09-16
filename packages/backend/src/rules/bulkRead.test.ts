import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BULK_READ_THRESHOLD } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { checkBulkRead } from "./bulkRead.js";

async function seedShare() {
  const agent = await prisma.agent.create({ data: { key: `agent-${randomUUID()}`, hostname: "h", watchedRoot: "/data" } });
  const server = await prisma.fileServer.create({
    data: { name: `fs-${randomUUID().slice(0, 6)}`, host: "fs01", username: "u", passwordEnc: "x" },
  });
  const source = await prisma.source.create({
    data: { kind: "SMB", rootLabel: "smb://fs01/finance", fileServerId: server.id, shareName: "finance", agentId: agent.id },
  });
  return { server, source };
}

async function seedReads(serverId: string, sourceId: string, count: number, userName = "jdoe", samePath = false) {
  for (let i = 0; i < count; i++) {
    await prisma.fileActivity.create({
      data: {
        fileServerId: serverId,
        sourceId,
        path: samePath ? "finance/one.xlsx" : `finance/file-${i}.xlsx`,
        action: "READ",
        userName,
        occurredAt: new Date(),
        recordId: BigInt(Date.now() * 1000 + i),
      },
    });
  }
}

describe("checkBulkRead", () => {
  it("alerts when one account reads far more files than working on documents would", async () => {
    const { server, source } = await seedShare();
    await seedReads(server.id, source.id, BULK_READ_THRESHOLD + 1);

    await checkBulkRead(source.id, "jdoe");

    const alerts = await prisma.alert.findMany({ where: { type: "BULK_FILE_READ" }, include: { responseActions: true } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("jdoe");
    expect(alerts[0].message).toContain("possible bulk copy");
    expect(alerts[0].responseActions.map((a) => a.type)).toEqual(["WEBHOOK_NOTIFICATION"]);
  });

  it("stays quiet for ordinary reading", async () => {
    const { server, source } = await seedShare();
    await seedReads(server.id, source.id, 10);
    await checkBulkRead(source.id, "jdoe");
    expect(await prisma.alert.count()).toBe(0);
  });

  it("counts distinct files, so re-reading one document all morning isn't an exfiltration", async () => {
    const { server, source } = await seedShare();
    await seedReads(server.id, source.id, BULK_READ_THRESHOLD + 20, "jdoe", true);
    await checkBulkRead(source.id, "jdoe");
    expect(await prisma.alert.count()).toBe(0);
  });

  it("raises one alert per burst, not one per poll", async () => {
    const { server, source } = await seedShare();
    await seedReads(server.id, source.id, BULK_READ_THRESHOLD + 1);
    await checkBulkRead(source.id, "jdoe");
    await seedReads(server.id, source.id, 5, "jdoe");
    await checkBulkRead(source.id, "jdoe");
    expect(await prisma.alert.count({ where: { type: "BULK_FILE_READ" } })).toBe(1);
  });
});
