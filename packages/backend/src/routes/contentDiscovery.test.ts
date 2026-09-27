import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { seedAuthedAgent } from "../auth/agentFixtures.testutil.js";
import { deleteSourcesWithHistory } from "./fileServers.js";

async function setup() {
  const app = await buildApp({ logger: false });
  const seeded = await seedAuthedAgent();
  const source = await prisma.source.create({ data: { kind: "LOCAL", rootLabel: `/srv/${randomUUID().slice(0, 6)}`, agentId: seeded.agent.id } });
  const post = (url: string, payload: object) =>
    app.inject({ method: "POST", url, headers: seeded.headers, payload: { agentKey: seeded.agent.key, sourceId: source.id, ...payload } });
  return { app, seeded, source, post };
}

const sample = (text: string) => Buffer.from(text).toString("base64");
const file = (over: object = {}) => ({ path: "HR/payroll.xlsx", sizeBytes: 1000, mtimeMs: 5000, extractor: "xlsx", contentSample: sample("SSN 123-45-6789"), ...over });

async function viewerCookie(app: FastifyInstance) {
  const email = `v-${randomUUID()}@example.com`;
  await prisma.user.create({ data: { email, passwordHash: await hashPassword("viewer-password-1"), role: "VIEWER" } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "viewer-password-1" } });
  return `token=${res.cookies.find((c) => c.name === "token")!.value}`;
}

describe("content discovery ingest", () => {
  it("stores an examined file and queues it for classification — once, until it changes", async () => {
    const { source, post } = await setup();
    expect((await post("/ingest/content-scans", { files: [file()] })).json()).toEqual({ queued: 1 });
    // A restarted agent re-sending the same file changes nothing.
    expect((await post("/ingest/content-scans", { files: [file()] })).json()).toEqual({ queued: 0 });
    // Changed since: the old result and its matches are replaced.
    const job = await prisma.classificationJob.findFirstOrThrow({ where: { contentScan: { sourceId: source.id } } });
    await prisma.classificationMatch.create({ data: { classificationJobId: job.id, patternType: "SSN", redactedSample: "***-**-6789", path: "HR/payroll.xlsx", sourceId: source.id } });
    expect((await post("/ingest/content-scans", { files: [file({ sizeBytes: 1200 })] })).json()).toEqual({ queued: 1 });
    expect(await prisma.contentScan.count({ where: { sourceId: source.id } })).toBe(1);
    expect(await prisma.classificationMatch.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it("records a file with no text, without queueing it", async () => {
    const { source, post } = await setup();
    await post("/ingest/content-scans", { files: [file({ path: "scan.pdf", extractor: "pdf", contentSample: undefined, note: "no text layer (scanned PDF?)" })] });
    expect(await prisma.contentScan.findFirstOrThrow({ where: { sourceId: source.id } })).toMatchObject({ note: "no text layer (scanned PDF?)", contentSample: null });
    expect(await prisma.classificationJob.count({ where: { contentScan: { sourceId: source.id } } })).toBe(0);
  });

  it("lets the agent resume from what's been examined, and only its own sources", async () => {
    const { app, seeded, source, post } = await setup();
    await post("/ingest/content-scans", { files: [file()] });
    const mine = await app.inject({ method: "GET", url: `/agent-sync/sources/${source.id}/content-scans?agentKey=${seeded.agent.key}`, headers: seeded.headers });
    expect(mine.json()).toEqual([["HR/payroll.xlsx", 1000, 5000]]);
    const other = await seedAuthedAgent();
    const theirs = await app.inject({ method: "GET", url: `/agent-sync/sources/${source.id}/content-scans?agentKey=${other.agent.key}`, headers: other.headers });
    expect(theirs.statusCode).toBe(404);
  });

  it("follows the share: a deleted file's result goes, a rename moves it, a deleted share takes them all", async () => {
    const { source, post } = await setup();
    await post("/ingest/content-scans", { files: [file(), file({ path: "old-name.docx", extractor: "docx" })] });
    const now = new Date().toISOString();
    await post("/ingest/events", { eventType: "deleted", path: "HR/payroll.xlsx", occurredAt: now });
    await post("/ingest/events", { eventType: "renamed", path: "new-name.docx", previousPath: "old-name.docx", occurredAt: now });
    const paths = (await prisma.contentScan.findMany({ where: { sourceId: source.id } })).map((s) => s.path);
    expect(paths).toEqual(["new-name.docx"]);

    await prisma.$transaction((tx) => deleteSourcesWithHistory(tx, [source.id]));
    expect(await prisma.contentScan.count({ where: { sourceId: source.id } })).toBe(0);
  });

  it("reports coverage, so 0 matches can't read as 'nothing sensitive' when little was examined", async () => {
    const { app, source, post } = await setup();
    await prisma.source.update({ where: { id: source.id }, data: { lastFileCount: 100 } });
    await post("/ingest/discovery-progress", { candidates: 40, skippedType: 55, skippedSize: 5, passStartedAt: new Date().toISOString() });
    await post("/ingest/content-scans", { files: [file(), file({ path: "scan.pdf", extractor: "pdf", contentSample: undefined, note: "no text layer (scanned PDF?)" })] });
    const res = await app.inject({ method: "GET", url: "/content-discovery/coverage", headers: { cookie: await viewerCookie(app) } });
    expect(res.json().find((c: { sourceId: string }) => c.sourceId === source.id)).toMatchObject({
      totalFiles: 100,
      candidates: 40,
      skippedType: 55,
      skippedSize: 5,
      examined: 2,
      noText: 1,
      pendingClassification: 1,
      filesWithSensitiveData: 0,
      passFinishedAt: null,
    });
  });
});
