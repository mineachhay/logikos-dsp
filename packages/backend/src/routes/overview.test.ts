import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";

async function loginAsViewer(app: FastifyInstance): Promise<string> {
  const email = `viewer-${randomUUID()}@example.com`;
  const password = "correct-password-123";
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: "VIEWER" } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "token")!;
  return `${cookie.name}=${cookie.value}`;
}

async function seedAgent(hostname = "test-host") {
  const agent = await prisma.agent.create({
    data: { key: `agent-${randomUUID()}`, hostname, watchedRoot: "/tmp/test" },
  });
  const source = await prisma.source.create({ data: { kind: "LOCAL", rootLabel: "/tmp/test", agentId: agent.id } });
  return { ...agent, sourceId: source.id };
}

describe("GET /overview", () => {
  it("is readable by a VIEWER, not just an ADMIN", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAsViewer(app);
    const res = await app.inject({ method: "GET", url: "/overview", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("counts OPEN alerts by severity, excluding ACKNOWLEDGED/RESOLVED ones", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAsViewer(app);
    const agent = await seedAgent();
    await prisma.alert.create({ data: { type: "RANSOMWARE_RATE", severity: "CRITICAL", status: "OPEN", agentId: agent.id, message: "x" } });
    await prisma.alert.create({ data: { type: "SENSITIVE_DATA_EXPOSED", severity: "HIGH", status: "OPEN", agentId: agent.id, message: "x" } });
    await prisma.alert.create({ data: { type: "SENSITIVE_DATA_EXPOSED", severity: "HIGH", status: "OPEN", agentId: agent.id, message: "x" } });
    await prisma.alert.create({ data: { type: "SENSITIVE_DATA_EXPOSED", severity: "HIGH", status: "ACKNOWLEDGED", agentId: agent.id, message: "x" } });

    const res = await app.inject({ method: "GET", url: "/overview", headers: { cookie } });
    const body = res.json();
    expect(body.alerts.openBySeverity).toEqual({ CRITICAL: 1, HIGH: 2 });
    expect(body.alerts.openTotal).toBe(3);
  });

  it("sums only the latest storage snapshot per source, not every snapshot ever taken", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAsViewer(app);
    const agentA = await seedAgent("host-a");
    const agentB = await seedAgent("host-b");

    // Two snapshots for agentA at different times — only the later one
    // (200 bytes) should count, not both summed to 300.
    await prisma.storageSnapshot.create({
      data: { agentId: agentA.id, sourceId: agentA.sourceId, rootPath: "/a", totalBytes: 100n, fileCount: 1, takenAt: new Date("2026-01-01T00:00:00Z") },
    });
    await prisma.storageSnapshot.create({
      data: { agentId: agentA.id, sourceId: agentA.sourceId, rootPath: "/a", totalBytes: 200n, fileCount: 2, takenAt: new Date("2026-01-02T00:00:00Z") },
    });
    await prisma.storageSnapshot.create({
      data: { agentId: agentB.id, sourceId: agentB.sourceId, rootPath: "/b", totalBytes: 50n, fileCount: 5, takenAt: new Date("2026-01-01T00:00:00Z") },
    });

    const res = await app.inject({ method: "GET", url: "/overview", headers: { cookie } });
    const body = res.json();
    expect(body.storage.totalBytes).toBe("250"); // 200 (agentA's latest) + 50 (agentB's only one)
    expect(body.storage.fileCount).toBe(7);
  });

  it("groups classification matches by pattern type", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAsViewer(app);
    const agent = await seedAgent();
    const event = await prisma.fileEvent.create({
      data: { agentId: agent.id, sourceId: agent.sourceId, eventType: "CREATED", path: "/tmp/test/f.txt", occurredAt: new Date() },
    });
    const job = await prisma.classificationJob.create({ data: { fileEventId: event.id, status: "DONE" } });
    await prisma.classificationMatch.create({
      data: { classificationJobId: job.id, patternType: "SSN", redactedSample: "x", path: "/tmp/test/f.txt" },
    });
    await prisma.classificationMatch.create({
      data: { classificationJobId: job.id, patternType: "SSN", redactedSample: "x", path: "/tmp/test/f.txt" },
    });
    await prisma.classificationMatch.create({
      data: { classificationJobId: job.id, patternType: "EMAIL", redactedSample: "x", path: "/tmp/test/f.txt" },
    });

    const res = await app.inject({ method: "GET", url: "/overview", headers: { cookie } });
    const byPattern = Object.fromEntries(res.json().matchesByPattern.map((r: { patternType: string; count: number }) => [r.patternType, r.count]));
    expect(byPattern).toEqual({ SSN: 2, EMAIL: 1 });
  });

  it("returns a 14-day alert trend with zero-filled days, not just days that had alerts", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAsViewer(app);
    const res = await app.inject({ method: "GET", url: "/overview", headers: { cookie } });
    const trend = res.json().alertTrend;
    expect(trend).toHaveLength(14);
    expect(trend.every((d: { count: number }) => d.count === 0)).toBe(true);
  });
});
