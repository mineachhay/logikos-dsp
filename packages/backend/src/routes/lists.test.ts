import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { seedAuthedAgent } from "../auth/agentFixtures.testutil.js";
import { encryptSecret } from "@logikos-dsp/shared/credentials";

async function login(app: FastifyInstance, role: "ADMIN" | "VIEWER" = "ADMIN") {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  await prisma.user.create({ data: { email, passwordHash: await hashPassword("lists-test-pass-1"), role } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "lists-test-pass-1" } });
  const cookie = `token=${res.cookies.find((c) => c.name === "token")!.value}`;
  return {
    email,
    get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
    send: (method: "POST" | "PATCH", url: string, payload: object) => app.inject({ method, url, headers: { cookie }, payload }),
  };
}

async function share(activityEnabled = true) {
  const { agent } = await seedAuthedAgent();
  const server = await prisma.fileServer.create({
    data: { name: `fs-${randomUUID().slice(0, 6)}`, host: "192.0.2.10", username: "svc", passwordEnc: encryptSecret("x"), activityEnabled },
  });
  const source = await prisma.source.create({
    data: { kind: "SMB", rootLabel: "smb://192.0.2.10/it", fileServerId: server.id, shareName: "it", subPath: "", agentId: agent.id, scanIntervalSec: 60 },
  });
  return { agent, server, source };
}

const at = (iso: string) => new Date(iso);

describe("GET /events", () => {
  it("filters in the database, pages with a cursor, and hides Office temporary files when asked", async () => {
    const app = await buildApp({ logger: false });
    const user = await login(app, "VIEWER");
    const { agent, source } = await share();
    const rows = [
      { path: "18_Roster/2026/9-SEP.xlsx", eventType: "MODIFIED", sizeBytes: 120, occurredAt: at("2026-09-26T05:00:00Z") },
      { path: "18_Roster/2026/~$9-SEP.xlsx", eventType: "CREATED", sizeBytes: 165, occurredAt: at("2026-09-26T05:01:00Z") },
      { path: "18_Roster/2026/9-SEP.xlsx", eventType: "MODIFIED", sizeBytes: 125, occurredAt: at("2026-09-26T05:02:00Z"), actorUser: "CORP\\alice" },
      { path: "14_Infra/notes.txt", eventType: "CREATED", sizeBytes: 5, occurredAt: at("2026-09-26T05:03:00Z"), actorUser: "CORP\\bob" },
    ];
    for (const r of rows) await prisma.fileEvent.create({ data: { agentId: agent.id, sourceId: source.id, ...r } as never });

    const all = (await user.get("/events")).json();
    expect(all).toHaveLength(4);
    const visible = (await user.get("/events?hideTemp=1")).json();
    expect(visible.map((e: { path: string }) => e.path)).not.toContain("18_Roster/2026/~$9-SEP.xlsx");

    // Previous size of the same file, for "+5 B".
    const latest = visible.find((e: { sizeBytes: number }) => e.sizeBytes === 125);
    expect(latest.prevSizeBytes).toBe(120);

    expect((await user.get("/events?user=alice")).json()).toHaveLength(1);
    expect((await user.get("/events?path=18_roster/")).json()).toHaveLength(3); // any case
    expect((await user.get("/events?q=bob")).json()).toHaveLength(1);
    expect((await user.get("/events?from=2026-09-26T05:01:30Z&to=2026-09-26T05:02:30Z")).json()).toHaveLength(1);

    // Two pages of two, no overlap, then nothing.
    const page1 = (await user.get("/events?limit=2")).json();
    const last = page1[1];
    const page2 = (await user.get(`/events?limit=2&cursor=${encodeURIComponent(`${last.occurredAt}_${last.id}`)}`)).json();
    expect(page2).toHaveLength(2);
    expect(new Set([...page1, ...page2].map((e: { id: string }) => e.id)).size).toBe(4);
  });

  it("says why a change has no user: local, audit off, before audit began, or unmatched", async () => {
    const app = await buildApp({ logger: false });
    const user = await login(app, "VIEWER");
    const { agent, server, source } = await share(true);
    await prisma.fileActivity.create({
      data: { fileServerId: server.id, sourceId: source.id, path: "x", action: "WRITE", userName: "alice", occurredAt: at("2026-09-27T03:00:00Z"), recordId: 1n },
    });
    await prisma.fileEvent.create({ data: { agentId: agent.id, sourceId: source.id, eventType: "MODIFIED", path: "old.txt", occurredAt: at("2026-09-26T05:00:00Z") } });
    await prisma.fileEvent.create({ data: { agentId: agent.id, sourceId: source.id, eventType: "MODIFIED", path: "new.txt", occurredAt: at("2026-09-27T04:00:00Z") } });
    const local = await prisma.source.create({ data: { kind: "LOCAL", rootLabel: "/data", agentId: agent.id } });
    await prisma.fileEvent.create({ data: { agentId: agent.id, sourceId: local.id, eventType: "CREATED", path: "l.txt", occurredAt: at("2026-09-27T04:00:00Z") } });

    const byPath = Object.fromEntries((await user.get("/events")).json().map((e: { path: string }) => [e.path, e]));
    expect(byPath["old.txt"]).toMatchObject({ noActorReason: "before-audit", auditSince: "2026-09-27T03:00:00.000Z" });
    expect(byPath["new.txt"]).toMatchObject({ noActorReason: "unmatched" });
    expect(byPath["l.txt"]).toMatchObject({ noActorReason: "local" });
  });
});

describe("GET /file-activity", () => {
  it("finds one person's activity by DOMAIN\\user and summarises it", async () => {
    const app = await buildApp({ logger: false });
    const user = await login(app, "VIEWER");
    const { server, source } = await share();
    const base = { fileServerId: server.id, sourceId: source.id, userDomain: "CORP", occurredAt: at("2026-09-27T03:00:00Z") };
    const rows = [
      { path: "14_Infra/a.txt", action: "READ", userName: "alice" },
      { path: "14_INFRA/A.TXT", action: "WRITE", userName: "alice" },
      { path: "14_Infra/b.txt", action: "DELETE", userName: "alice" },
      { path: "18_Roster/c.xlsx", action: "READ", userName: "bob" },
    ];
    let id = 1n;
    for (const r of rows) await prisma.fileActivity.create({ data: { ...base, ...r, recordId: id++ } as never });

    expect((await user.get("/file-activity?user=CORP%5Calice")).json()).toHaveLength(3);
    expect((await user.get("/file-activity?user=bob")).json()).toHaveLength(1);
    const summary = (await user.get("/file-activity/summary?user=CORP%5Calice")).json();
    expect(summary).toMatchObject({ total: 3, byAction: { READ: 1, WRITE: 1, DELETE: 1 }, distinctFiles: 2 });
    expect(summary.topFolders[0]).toMatchObject({ count: 3 }); // 14_Infra and 14_INFRA are one folder
  });
});

describe("alerts workflow", () => {
  it("resolves with a note, records who, and shows it in the alert's history", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app);
    const alert = await prisma.alert.create({ data: { type: "RANSOMWARE_RATE", severity: "CRITICAL", message: "burst" } });
    const res = await admin.send("PATCH", `/alerts/${alert.id}`, { status: "RESOLVED", note: "false positive — Office save" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "RESOLVED", resolvedByEmail: admin.email, acknowledgedByEmail: admin.email, note: "false positive — Office save" });
    const detail = (await admin.get(`/alerts/${alert.id}`)).json();
    expect(detail.history[0]).toMatchObject({ action: "alert.resolved", userEmail: admin.email, details: { from: "OPEN", note: "false positive — Office save" } });
  });

  it("acknowledges several at once, admins only", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app);
    const viewer = await login(app, "VIEWER");
    const ids = await Promise.all([1, 2, 3].map(async () => (await prisma.alert.create({ data: { type: "BULK_FILE_READ", severity: "MEDIUM", message: "m" } })).id));
    expect((await viewer.send("POST", "/alerts/bulk", { ids, status: "ACKNOWLEDGED" })).statusCode).toBe(403);
    expect((await admin.send("POST", "/alerts/bulk", { ids, status: "ACKNOWLEDGED" })).json()).toEqual({ updated: 3 });
    expect(await prisma.alert.count({ where: { status: "ACKNOWLEDGED", acknowledgedByEmail: admin.email } })).toBe(3);
    // The default view: open and acknowledged, not resolved.
    await prisma.alert.create({ data: { type: "BULK_FILE_READ", severity: "LOW", message: "done", status: "RESOLVED" } });
    expect((await admin.get("/alerts?status=OPEN,ACKNOWLEDGED")).json()).toHaveLength(3);
  });

  it("lists the file changes behind a mass-change alert", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app);
    const { agent, source } = await share();
    const when = new Date();
    await prisma.fileEvent.create({ data: { agentId: agent.id, sourceId: source.id, eventType: "DELETED", path: "a.docx", occurredAt: when } });
    await prisma.fileEvent.create({ data: { agentId: agent.id, sourceId: source.id, eventType: "DELETED", path: "other.docx", occurredAt: when } });
    const alert = await prisma.alert.create({
      data: { type: "RANSOMWARE_RATE", severity: "CRITICAL", message: "burst", sourceId: source.id, metadata: { count: 50, windowSeconds: 60, affectedPaths: ["a.docx"] } },
    });
    const detail = (await admin.get(`/alerts/${alert.id}`)).json();
    expect(detail.related.kind).toBe("events");
    expect(detail.related.rows.map((r: { path: string }) => r.path)).toEqual(["a.docx"]);
  });
});

describe("GET /overview additions", () => {
  it("counts temporary files apart, ranks matches by severity, and shows pending approvals and busy users", async () => {
    const app = await buildApp({ logger: false });
    const user = await login(app, "VIEWER");
    const { agent, server, source } = await share();
    const now = new Date();
    await prisma.fileEvent.create({ data: { agentId: agent.id, sourceId: source.id, eventType: "CREATED", path: "r/~$x.xlsx", occurredAt: now } });
    await prisma.fileEvent.create({ data: { agentId: agent.id, sourceId: source.id, eventType: "MODIFIED", path: "r/x.xlsx", occurredAt: now } });
    await prisma.fileActivity.create({ data: { fileServerId: server.id, sourceId: source.id, path: "r/x.xlsx", action: "WRITE", userName: "alice", userDomain: "CORP", occurredAt: now, recordId: 9n } });
    const alert = await prisma.alert.create({ data: { type: "BULK_FILE_READ", severity: "HIGH", message: "m" } });
    await prisma.responseAction.create({ data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" } });
    const event = await prisma.fileEvent.findFirstOrThrow({ where: { path: "r/x.xlsx" } });
    const job = await prisma.classificationJob.create({ data: { fileEventId: event.id, status: "DONE" } });
    for (let i = 0; i < 3; i++) await prisma.classificationMatch.create({ data: { classificationJobId: job.id, patternType: "EMAIL", redactedSample: "a***", path: "r/x.xlsx" } });
    await prisma.classificationMatch.create({ data: { classificationJobId: job.id, patternType: "CREDIT_CARD", redactedSample: "4***", path: "r/x.xlsx" } });

    const body = (await user.get("/overview")).json();
    expect(body).toMatchObject({ eventsLast24h: 1, tempEventsLast24h: 1, pendingApprovals: 1 });
    expect(body.topUsers[0]).toMatchObject({ user: "CORP\\alice", changes: 1, reads: 0 });
    expect(body.matchesByPattern.map((m: { patternType: string }) => m.patternType)).toEqual(["CREDIT_CARD", "EMAIL"]);
    expect(body.bursts[0]).toMatchObject({ count: 1 });
  });
});
