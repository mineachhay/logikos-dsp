import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { MANAGED_SOURCES_CAPABILITY } from "@logikos-dsp/shared";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { decryptSecret } from "../crypto/credentials.js";
import { seedAuthedAgent } from "../auth/agentFixtures.testutil.js";

async function loginAs(app: FastifyInstance, role: "ADMIN" | "VIEWER"): Promise<string> {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const password = "correct-password-123";
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "token")!;
  return `${cookie.name}=${cookie.value}`;
}

async function managedAgent() {
  const seeded = await seedAuthedAgent();
  await prisma.agent.update({ where: { id: seeded.agent.id }, data: { capabilities: [MANAGED_SOURCES_CAPABILITY] } });
  return seeded;
}

async function setup() {
  const app = await buildApp({ logger: false });
  const cookie = await loginAs(app, "ADMIN");
  const as = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie } });
  return { app, cookie, as };
}

async function createServer(as: Awaited<ReturnType<typeof setup>>["as"], overrides: object = {}) {
  const res = await as("POST", "/file-servers", {
    name: `fs-${randomUUID().slice(0, 8)}`,
    host: "fs01.corp.local",
    domain: "CORP",
    username: "svc-dsp",
    password: "hunter2-share-password",
    ...overrides,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("file server management", () => {
  it("is ADMIN-only", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAs(app, "VIEWER");
    expect((await app.inject({ method: "GET", url: "/file-servers", headers: { cookie } })).statusCode).toBe(403);
    const create = await app.inject({
      method: "POST",
      url: "/file-servers",
      headers: { cookie },
      payload: { name: "x", host: "fs01", username: "u", password: "p" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("stores the password encrypted and never returns it", async () => {
    const { as } = await setup();
    const server = await createServer(as);

    expect(JSON.stringify(server)).not.toContain("hunter2");
    expect(server).not.toHaveProperty("passwordEnc");
    const listed = (await as("GET", "/file-servers")).json();
    expect(JSON.stringify(listed)).not.toContain("hunter2");
    expect(listed[0]).not.toHaveProperty("passwordEnc");

    const row = await prisma.fileServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(row.passwordEnc).not.toContain("hunter2");
    expect(decryptSecret(row.passwordEnc)).toBe("hunter2-share-password");
  });

  it("keeps the stored password when an edit omits it, and audits without the value", async () => {
    const { as } = await setup();
    const server = await createServer(as);
    const before = await prisma.fileServer.findUniqueOrThrow({ where: { id: server.id } });

    await as("PATCH", `/file-servers/${server.id}`, { username: "svc-dsp2" });
    expect((await prisma.fileServer.findUniqueOrThrow({ where: { id: server.id } })).passwordEnc).toBe(before.passwordEnc);

    await as("PATCH", `/file-servers/${server.id}`, { password: "new-secret-pass" });
    const after = await prisma.fileServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(decryptSecret(after.passwordEnc)).toBe("new-secret-pass");

    const audit = await prisma.auditLog.findMany({ where: { targetId: server.id } });
    expect(audit.map((a) => a.action).sort()).toEqual(["fileServer.create", "fileServer.update", "fileServer.update"]);
    expect(JSON.stringify(audit)).not.toMatch(/hunter2|new-secret-pass/);
    expect(audit.some((a) => (a.details as { passwordReplaced?: boolean }).passwordReplaced === true)).toBe(true);
  });

  it("rejects hosts with schemes, share names with slashes, and subPaths that escape the share", async () => {
    const { as } = await setup();
    expect((await as("POST", "/file-servers", { name: "a", host: "smb://fs01", username: "u", password: "p" })).statusCode).toBe(400);

    const server = await createServer(as);
    const { agent } = await managedAgent();
    const badShare = await as("POST", `/file-servers/${server.id}/shares`, { shareName: "fin/q1", agentId: agent.id });
    expect(badShare.statusCode).toBe(400);
    const escaping = await as("POST", `/file-servers/${server.id}/shares`, { shareName: "fin", subPath: "../../etc", agentId: agent.id });
    expect(escaping.statusCode).toBe(400);
  });
});

describe("shares", () => {
  it("assigns a share only to an agent that supports managed sources", async () => {
    const { as } = await setup();
    const server = await createServer(as);
    const legacy = await seedAuthedAgent(); // no capability — e.g. the Go agent
    const res = await as("POST", `/file-servers/${server.id}/shares`, { shareName: "finance", agentId: legacy.agent.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("can't scan");
  });

  it("creates a share with a normalized root label and refuses duplicates", async () => {
    const { as } = await setup();
    const server = await createServer(as);
    const { agent } = await managedAgent();
    const payload = { shareName: "finance", subPath: "\\q1\\exports\\", agentId: agent.id };

    const res = await as("POST", `/file-servers/${server.id}/shares`, payload);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ rootLabel: "smb://fs01.corp.local/finance/q1/exports", subPath: "q1/exports", kind: "SMB" });
    expect((await as("POST", `/file-servers/${server.id}/shares`, payload)).statusCode).toBe(409);
  });

  it("relabels shares when the server's host changes", async () => {
    const { as } = await setup();
    const server = await createServer(as);
    const { agent } = await managedAgent();
    const share = (await as("POST", `/file-servers/${server.id}/shares`, { shareName: "finance", agentId: agent.id })).json();

    await as("PATCH", `/file-servers/${server.id}`, { host: "fs02.corp.local" });
    expect((await prisma.source.findUniqueOrThrow({ where: { id: share.id } })).rootLabel).toBe("smb://fs02.corp.local/finance");
  });
});

describe("agent sync", () => {
  it("gives each agent only its own enabled shares, with the password decrypted", async () => {
    const { app, as } = await setup();
    const server = await createServer(as);
    const mine = await managedAgent();
    const other = await managedAgent();
    await as("POST", `/file-servers/${server.id}/shares`, { shareName: "finance", agentId: mine.agent.id });
    const disabled = (await as("POST", `/file-servers/${server.id}/shares`, { shareName: "hr", agentId: mine.agent.id })).json();
    await as("POST", `/shares/${disabled.id}/disable`);
    await as("POST", `/file-servers/${server.id}/shares`, { shareName: "legal", agentId: other.agent.id });

    const sync = await app.inject({ method: "GET", url: `/agent-sync?agentKey=${mine.agent.key}`, headers: mine.headers });
    expect(sync.statusCode).toBe(200);
    const { sources } = sync.json();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ share: "finance", host: "fs01.corp.local", domain: "CORP", username: "svc-dsp", password: "hunter2-share-password" });

    await as("POST", `/file-servers/${server.id}/disable`);
    const afterDisable = await app.inject({ method: "GET", url: `/agent-sync?agentKey=${mine.agent.key}`, headers: mine.headers });
    expect(afterDisable.json().sources).toHaveLength(0);
  });

  it("requires agent credentials", async () => {
    const { app } = await setup();
    const { agent } = await managedAgent();
    expect((await app.inject({ method: "GET", url: `/agent-sync?agentKey=${agent.key}` })).statusCode).toBe(401);
  });

  it("links ingest to the assigned share, and refuses another agent's share", async () => {
    const { app, as } = await setup();
    const server = await createServer(as);
    const mine = await managedAgent();
    const other = await managedAgent();
    const share = (await as("POST", `/file-servers/${server.id}/shares`, { shareName: "finance", agentId: mine.agent.id })).json();

    const event = (agentKey: string, sourceId?: string) => [
      { agentKey, sourceId, eventType: "created", path: "q1.csv", occurredAt: new Date().toISOString() },
    ];
    const ok = await app.inject({ method: "POST", url: "/ingest/events", payload: event(mine.agent.key, share.id), headers: mine.headers });
    expect(ok.statusCode).toBe(200);
    expect((await prisma.fileEvent.findFirstOrThrow()).sourceId).toBe(share.id);

    const stolen = await app.inject({ method: "POST", url: "/ingest/events", payload: event(other.agent.key, share.id), headers: other.headers });
    expect(stolen.statusCode).toBe(404);

    // No sourceId → the agent's own default source (created on demand for agents that predate it).
    const legacy = await app.inject({ method: "POST", url: "/ingest/events", payload: event(other.agent.key), headers: other.headers });
    expect(legacy.statusCode).toBe(200);
    const defaultSource = await prisma.source.findFirstOrThrow({ where: { agentId: other.agent.id, fileServerId: null } });
    expect(await prisma.fileEvent.count({ where: { sourceId: defaultSource.id } })).toBe(1);
  });

  it("records scan status reported by the assigned agent only", async () => {
    const { app, as } = await setup();
    const server = await createServer(as);
    const mine = await managedAgent();
    const other = await managedAgent();
    const share = (await as("POST", `/file-servers/${server.id}/shares`, { shareName: "finance", agentId: mine.agent.id })).json();

    const report = (seeded: typeof mine, payload: object) =>
      app.inject({ method: "POST", url: `/agent-sync/sources/${share.id}/status`, headers: seeded.headers, payload: { agentKey: seeded.agent.key, ...payload } });

    expect((await report(other, { ok: true, fileCount: 1 })).statusCode).toBe(404);
    expect((await report(mine, { ok: true, fileCount: 12, totalBytes: 3456 })).statusCode).toBe(200);
    const listed = (await as("GET", "/file-servers")).json();
    expect(listed[0].shares[0]).toMatchObject({ lastFileCount: 12, lastTotalBytes: "3456", lastScanError: null });

    await report(mine, { ok: false, error: "STATUS_LOGON_FAILURE" });
    expect((await prisma.source.findUniqueOrThrow({ where: { id: share.id } })).lastScanError).toBe("STATUS_LOGON_FAILURE");
  });

  it("runs a connection test through the agent, and times out one nobody picks up", async () => {
    const { app, as } = await setup();
    const server = await createServer(as);
    const mine = await managedAgent();

    const test = (await as("POST", `/file-servers/${server.id}/connection-tests`, { shareName: "finance", agentId: mine.agent.id })).json();
    const sync = (await app.inject({ method: "GET", url: `/agent-sync?agentKey=${mine.agent.key}`, headers: mine.headers })).json();
    expect(sync.connectionTests).toEqual([expect.objectContaining({ id: test.id, share: "finance", password: "hunter2-share-password" })]);

    await app.inject({
      method: "POST",
      url: `/agent-sync/connection-tests/${test.id}/complete`,
      headers: mine.headers,
      payload: { agentKey: mine.agent.key, success: true, message: "listed 3 entries" },
    });
    expect((await as("GET", `/connection-tests/${test.id}`)).json()).toMatchObject({ status: "SUCCEEDED", message: "listed 3 entries" });

    const stale = (await as("POST", `/file-servers/${server.id}/connection-tests`, { shareName: "hr", agentId: mine.agent.id })).json();
    await prisma.connectionTest.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    expect((await as("GET", `/connection-tests/${stale.id}`)).json().status).toBe("FAILED");
  });
});

describe("disable vs delete", () => {
  async function shareWithHistory() {
    const ctx = await setup();
    const server = await createServer(ctx.as);
    const mine = await managedAgent();
    const share = (await ctx.as("POST", `/file-servers/${server.id}/shares`, { shareName: "finance", agentId: mine.agent.id })).json();
    const event = await prisma.fileEvent.create({
      data: { agentId: mine.agent.id, sourceId: share.id, eventType: "CREATED", path: "a.csv", occurredAt: new Date() },
    });
    const job = await prisma.classificationJob.create({ data: { fileEventId: event.id, status: "DONE" } });
    await prisma.classificationMatch.create({ data: { classificationJobId: job.id, patternType: "SSN", redactedSample: "x", path: "a.csv" } });
    const alert = await prisma.alert.create({
      data: { type: "SENSITIVE_DATA_EXPOSED", severity: "HIGH", message: "x", agentId: mine.agent.id, sourceId: share.id },
    });
    await prisma.responseAction.create({ data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" } });
    await prisma.storageSnapshot.create({
      data: { agentId: mine.agent.id, sourceId: share.id, rootPath: share.rootLabel, totalBytes: 1n, fileCount: 1, takenAt: new Date() },
    });
    return { ...ctx, server, share, mine };
  }

  it("disabling keeps every row of history", async () => {
    const { as, server } = await shareWithHistory();
    await as("POST", `/file-servers/${server.id}/disable`);
    expect(await prisma.fileEvent.count()).toBe(1);
    expect(await prisma.alert.count()).toBe(1);
  });

  it("deleting needs the exact name, then removes the server's history and nothing else", async () => {
    const { as, server, mine } = await shareWithHistory();
    // Unrelated history on the agent's own source must survive.
    const own = await prisma.source.create({ data: { kind: "LOCAL", rootLabel: "/data", agentId: mine.agent.id } });
    await prisma.fileEvent.create({ data: { agentId: mine.agent.id, sourceId: own.id, eventType: "CREATED", path: "/data/x", occurredAt: new Date() } });

    expect((await as("DELETE", `/file-servers/${server.id}?confirm=wrong`)).statusCode).toBe(400);
    expect(await prisma.fileServer.count()).toBe(1);

    const res = await as("DELETE", `/file-servers/${server.id}?confirm=${encodeURIComponent(server.name)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toEqual({ fileEvents: 1, storageSnapshots: 1, alerts: 1 });
    expect(await prisma.fileServer.count()).toBe(0);
    expect(await prisma.classificationMatch.count()).toBe(0);
    expect(await prisma.responseAction.count()).toBe(0);
    expect(await prisma.fileEvent.count({ where: { sourceId: own.id } })).toBe(1);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "fileServer.delete" } });
    expect(audit.details).toMatchObject({ name: server.name, deleted: { fileEvents: 1 } });
  });

  it("deleting a single share needs its share name", async () => {
    const { as, share } = await shareWithHistory();
    expect((await as("DELETE", `/shares/${share.id}?confirm=nope`)).statusCode).toBe(400);
    expect((await as("DELETE", `/shares/${share.id}?confirm=finance`)).statusCode).toBe(200);
    expect(await prisma.source.count({ where: { id: share.id } })).toBe(0);
  });
});
