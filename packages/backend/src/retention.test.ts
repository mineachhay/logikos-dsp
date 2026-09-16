import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import { cutoffsFor, runRetention, summarize } from "./retention.js";

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function enableRetention(overrides: object = {}) {
  return prisma.retentionSettings.upsert({
    where: { id: "default" },
    update: { enabled: true, ...overrides },
    create: { id: "default", enabled: true, ...overrides },
  });
}

async function seedSource() {
  const agent = await prisma.agent.create({
    data: { key: `agent-${randomUUID()}`, hostname: "host", watchedRoot: "/data" },
  });
  const source = await prisma.source.create({ data: { kind: "LOCAL", rootLabel: "/data", agentId: agent.id } });
  return { agent, source };
}

describe("cutoffsFor", () => {
  it("turns each setting into a date", () => {
    const now = new Date("2026-09-16T12:00:00Z");
    const cutoffs = cutoffsFor(
      { fileEventDays: 30, fileActivityDays: 7, storageSnapshotDays: 365, resolvedAlertDays: 90, loginAttemptDays: 1 },
      now,
    );
    expect(cutoffs.fileEvents).toEqual(new Date("2026-08-17T12:00:00Z"));
    expect(cutoffs.loginAttempts).toEqual(new Date("2026-09-15T12:00:00Z"));
  });
});

describe("summarize", () => {
  it("says what it deleted, or that there was nothing to do", () => {
    expect(summarize({ fileEvents: 3, classificationMatches: 0, fileActivity: 1, storageSnapshots: 0, alerts: 0, loginAttempts: 0 })).toBe(
      "deleted 3 file events, 1 file activity",
    );
    expect(summarize({ fileEvents: 0, classificationMatches: 0, fileActivity: 0, storageSnapshots: 0, alerts: 0, loginAttempts: 0 })).toBe(
      "nothing to delete",
    );
  });
});

describe("runRetention", () => {
  it("deletes nothing at all while it's switched off", async () => {
    const { agent, source } = await seedSource();
    await prisma.fileEvent.create({
      data: { agentId: agent.id, sourceId: source.id, eventType: "CREATED", path: "/data/old.txt", occurredAt: daysAgo(900) },
    });
    expect(await runRetention()).toBeNull();
    expect(await prisma.fileEvent.count()).toBe(1);
  });

  it("deletes file events past their age, with their classification results, and keeps recent ones", async () => {
    const { agent, source } = await seedSource();
    await enableRetention({ fileEventDays: 30 });
    const old = await prisma.fileEvent.create({
      data: { agentId: agent.id, sourceId: source.id, eventType: "CREATED", path: "/data/old.txt", occurredAt: daysAgo(60) },
    });
    const job = await prisma.classificationJob.create({ data: { fileEventId: old.id, status: "DONE" } });
    await prisma.classificationMatch.create({ data: { classificationJobId: job.id, patternType: "SSN", redactedSample: "x", path: "/data/old.txt" } });
    await prisma.fileEvent.create({
      data: { agentId: agent.id, sourceId: source.id, eventType: "CREATED", path: "/data/recent.txt", occurredAt: daysAgo(3) },
    });

    const result = await runRetention();
    expect(result).toMatchObject({ fileEvents: 1, classificationMatches: 1 });
    expect((await prisma.fileEvent.findMany()).map((e) => e.path)).toEqual(["/data/recent.txt"]);
    expect(await prisma.classificationJob.count()).toBe(0);
    expect(await prisma.classificationMatch.count()).toBe(0);
  });

  it("keeps each source's newest storage snapshot however old it is, so the Storage view doesn't empty out", async () => {
    const { agent, source } = await seedSource();
    await enableRetention({ storageSnapshotDays: 30 });
    for (const age of [400, 300, 200]) {
      await prisma.storageSnapshot.create({
        data: { agentId: agent.id, sourceId: source.id, rootPath: "/data", totalBytes: 1n, fileCount: 1, takenAt: daysAgo(age) },
      });
    }

    const result = await runRetention();
    expect(result!.storageSnapshots).toBe(2);
    const left = await prisma.storageSnapshot.findMany();
    expect(left).toHaveLength(1);
    expect(left[0].takenAt.getTime()).toBeCloseTo(daysAgo(200).getTime(), -4);
  });

  it("deletes only resolved alerts — an open one is still someone's to-do", async () => {
    const { agent, source } = await seedSource();
    await enableRetention({ resolvedAlertDays: 30 });
    for (const status of ["RESOLVED", "OPEN", "ACKNOWLEDGED"] as const) {
      const alert = await prisma.alert.create({
        data: { type: "SENSITIVE_DATA_EXPOSED", severity: "HIGH", status, message: status, agentId: agent.id, sourceId: source.id, createdAt: daysAgo(90) },
      });
      await prisma.responseAction.create({ data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" } });
    }

    const result = await runRetention();
    expect(result!.alerts).toBe(1);
    expect((await prisma.alert.findMany()).map((a) => a.status).sort()).toEqual(["ACKNOWLEDGED", "OPEN"]);
    expect(await prisma.responseAction.count()).toBe(2);
  });

  it("thins activity and login attempts, and records what it did", async () => {
    const { agent, source } = await seedSource();
    const server = await prisma.fileServer.create({
      data: { name: `fs-${randomUUID().slice(0, 6)}`, host: "fs01", username: "u", passwordEnc: "x" },
    });
    await enableRetention({ fileActivityDays: 30, loginAttemptDays: 7 });
    await prisma.fileActivity.create({
      data: { fileServerId: server.id, sourceId: source.id, path: "a.txt", action: "WRITE", userName: "jdoe", occurredAt: daysAgo(60), recordId: 1n },
    });
    await prisma.fileActivity.create({
      data: { fileServerId: server.id, sourceId: source.id, path: "b.txt", action: "WRITE", userName: "jdoe", occurredAt: daysAgo(2), recordId: 2n },
    });
    await prisma.loginAttempt.create({ data: { ip: "1.2.3.4", email: "a@b.c", success: false, at: daysAgo(30) } });

    const result = await runRetention();
    expect(result).toMatchObject({ fileActivity: 1, loginAttempts: 1 });
    expect(await prisma.fileActivity.count()).toBe(1);
    const settings = await prisma.retentionSettings.findUniqueOrThrow({ where: { id: "default" } });
    expect(settings.lastRunAt).not.toBeNull();
    expect(settings.lastRunSummary).toContain("deleted");
    void agent;
  });
});
