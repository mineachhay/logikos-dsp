import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { prisma } from "./db.js";
import { hashPassword } from "./auth/passwords.js";
import { seedAuthedAgent } from "./auth/agentFixtures.testutil.js";
import { thinSnapshots } from "./retention.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("thinSnapshots", () => {
  it("keeps one per hour after a day and one per day after 30 days, and the newest always", async () => {
    const { agent } = await seedAuthedAgent();
    const source = await prisma.source.create({ data: { kind: "LOCAL", rootLabel: "/srv/x", agentId: agent.id } });
    const now = new Date("2026-09-27T12:30:00Z");
    const at = (ms: number) => new Date(now.getTime() - ms);
    const times = [
      at(10 * 60_000), // recent: untouched, however many
      at(20 * 60_000),
      at(2 * DAY), // same hour, three scans → one kept
      at(2 * DAY + 60_000),
      at(2 * DAY + 120_000),
      at(40 * DAY), // same day, two scans → one kept
      at(40 * DAY + 3 * HOUR),
    ];
    for (const takenAt of times) {
      await prisma.storageSnapshot.create({ data: { agentId: agent.id, sourceId: source.id, rootPath: "x", totalBytes: 1n, fileCount: 1, takenAt } });
    }
    expect(await thinSnapshots(prisma, now)).toBe(3);
    const left = (await prisma.storageSnapshot.findMany({ orderBy: { takenAt: "desc" } })).map((s) => s.takenAt.getTime());
    expect(left).toEqual([times[0], times[1], times[2], times[5]].map((d) => d!.getTime()));
  });
});

async function adminCookie(app: FastifyInstance) {
  const email = `a-${randomUUID()}@example.com`;
  await prisma.user.create({ data: { email, passwordHash: await hashPassword("health-test-pass-1"), role: "ADMIN" } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "health-test-pass-1" } });
  return `token=${res.cookies.find((c) => c.name === "token")!.value}`;
}

describe("GET /system/health", () => {
  it("reports the backup worker's disk space and warns when backups are stale or space is short", async () => {
    const app = await buildApp({ logger: false });
    await prisma.backupSettings.create({ data: { id: "default", workerHeartbeatAt: new Date(), workerDiskFreeBytes: 5n * 1024n ** 3n, workerDiskTotalBytes: 100n * 1024n ** 3n } });
    const res = await app.inject({ method: "GET", url: "/system/health", headers: { cookie: await adminCookie(app) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.backups).toMatchObject({ workerOnline: true, diskFreeBytes: 5 * 1024 ** 3, lastSuccessAt: null });
    expect(body.warnings.map((w: { message: string }) => w.message)).toEqual(
      expect.arrayContaining(["No successful backup in the last 48 hours", "Less than 10% disk space left where backups are kept"]),
    );
    expect(body.database.sizeBytes).toBeGreaterThan(0);
  });

  it("is for admins only", async () => {
    const app = await buildApp({ logger: false });
    const email = `v-${randomUUID()}@example.com`;
    await prisma.user.create({ data: { email, passwordHash: await hashPassword("health-test-pass-1"), role: "VIEWER" } });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "health-test-pass-1" } });
    const res = await app.inject({ method: "GET", url: "/system/health", headers: { cookie: `token=${login.cookies.find((c) => c.name === "token")!.value}` } });
    expect(res.statusCode).toBe(403);
  });
});
