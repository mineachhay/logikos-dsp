import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { seedAuthedAgent } from "../auth/agentFixtures.testutil.js";

async function loginAsViewer(app: FastifyInstance): Promise<string> {
  const email = `viewer-${randomUUID()}@example.com`;
  await prisma.user.create({ data: { email, passwordHash: await hashPassword("correct-password-123"), role: "VIEWER" } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct-password-123" } });
  return `token=${res.cookies.find((c) => c.name === "token")!.value}`;
}

const daysAgo = (d: number, minutes = 0) => new Date(Date.now() - d * 86_400_000 - minutes * 60_000);

describe("GET /storage/summary", () => {
  it("gives each source's latest size, its size a week ago, a daily history, and whether it ever held a file", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAsViewer(app);
    const { agent } = await seedAuthedAgent();
    const share = await prisma.source.create({ data: { kind: "LOCAL", rootLabel: "/srv/share", agentId: agent.id } });
    const empty = await prisma.source.create({ data: { kind: "LOCAL", rootLabel: "/data", agentId: agent.id } });
    const snap = (sourceId: string, totalBytes: number, fileCount: number, takenAt: Date) =>
      prisma.storageSnapshot.create({ data: { agentId: agent.id, sourceId, rootPath: "x", totalBytes: BigInt(totalBytes), fileCount, takenAt } });
    await snap(share.id, 1000, 10, daysAgo(8));
    await snap(share.id, 1500, 12, daysAgo(1, 10)); // earlier the same day…
    await snap(share.id, 1600, 13, daysAgo(1)); // …the day's last one wins
    await snap(share.id, 2000, 20, daysAgo(0));
    await snap(empty.id, 0, 0, daysAgo(0));

    const res = await app.inject({ method: "GET", url: "/storage/summary", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const byLabel = Object.fromEntries(res.json().map((s: { rootLabel: string }) => [s.rootLabel, s]));
    expect(byLabel["/srv/share"]).toMatchObject({ totalBytes: "2000", fileCount: 20, weekAgo: { totalBytes: "1000", fileCount: 10 }, everHadFiles: true });
    expect(byLabel["/srv/share"].history.map((h: { totalBytes: string }) => h.totalBytes)).toEqual(["1000", "1600", "2000"]); // 8 days ago is inside the 30-day window
    expect(byLabel["/data"]).toMatchObject({ everHadFiles: false, weekAgo: null });
  });
});
