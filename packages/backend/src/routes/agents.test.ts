import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { seedAuthedAgent } from "../auth/agentFixtures.testutil.js";

const enroll = { authorization: `Bearer ${process.env.AGENT_ENROLL_TOKEN}` };

function registerPayload(key = `agent-${randomUUID()}`) {
  return { key, hostname: "test-host", watchedRoot: "/tmp/test" };
}

function event(agentKey: string, path = "/tmp/test/a.txt") {
  return { agentKey, eventType: "created", path, occurredAt: new Date().toISOString() };
}

async function loginAs(app: FastifyInstance, role: "ADMIN" | "VIEWER"): Promise<string> {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const password = "correct-password-123";
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "token")!;
  return `${cookie.name}=${cookie.value}`;
}

describe("POST /agents/register", () => {
  it("rejects a missing or wrong enroll token", async () => {
    const app = await buildApp({ logger: false });
    const none = await app.inject({ method: "POST", url: "/agents/register", payload: registerPayload() });
    const wrong = await app.inject({
      method: "POST",
      url: "/agents/register",
      payload: registerPayload(),
      headers: { authorization: "Bearer not-the-enroll-token" },
    });
    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(await prisma.agent.count()).toBe(0);
  });

  it("issues a secret and stores only its hash", async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: "POST", url: "/agents/register", payload: registerPayload(), headers: enroll });

    expect(res.statusCode).toBe(200);
    const { agentSecret } = res.json();
    expect(agentSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const row = await prisma.agent.findFirstOrThrow();
    expect(row.secretHash).not.toBeNull();
    expect(row.secretHash).not.toContain(agentSecret);
  });

  it("rotates the secret on re-registration, cutting off the old one", async () => {
    const app = await buildApp({ logger: false });
    const payload = registerPayload();
    const first = (await app.inject({ method: "POST", url: "/agents/register", payload, headers: enroll })).json();
    const second = (await app.inject({ method: "POST", url: "/agents/register", payload, headers: enroll })).json();

    expect(second.id).toBe(first.id);
    const post = (secret: string) =>
      app.inject({
        method: "POST",
        url: "/ingest/events",
        payload: [event(payload.key)],
        headers: { authorization: `Bearer ${secret}` },
      });
    expect((await post(first.agentSecret)).statusCode).toBe(401);
    expect((await post(second.agentSecret)).statusCode).toBe(200);
  });

  it("returns 400, not a 500 with a Zod dump, for a malformed body", async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: "POST", url: "/agents/register", payload: {}, headers: enroll });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid request" });
  });
});

describe("agent credentials on ingest and commands", () => {
  it("rejects ingest with no secret, a wrong secret, or another agent's secret", async () => {
    const app = await buildApp({ logger: false });
    const mine = await seedAuthedAgent();
    const other = await seedAuthedAgent();
    const send = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/ingest/events", payload: [event(mine.agent.key)], headers });

    expect((await send({})).statusCode).toBe(401);
    expect((await send({ authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await send(other.headers)).statusCode).toBe(401);
    expect((await send(mine.headers)).statusCode).toBe(200);
    expect(await prisma.fileEvent.count()).toBe(1);
  });

  it("refuses a batch mixing agent keys", async () => {
    const app = await buildApp({ logger: false });
    const mine = await seedAuthedAgent();
    const other = await seedAuthedAgent();
    const res = await app.inject({
      method: "POST",
      url: "/ingest/events",
      payload: [event(mine.agent.key), event(other.agent.key)],
      headers: mine.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.fileEvent.count()).toBe(0);
  });

  it("authenticates storage snapshots too", async () => {
    const app = await buildApp({ logger: false });
    const { agent, headers } = await seedAuthedAgent();
    const payload = { agentKey: agent.key, rootPath: "/tmp/test", totalBytes: 1, fileCount: 1, takenAt: new Date().toISOString() };
    expect((await app.inject({ method: "POST", url: "/ingest/storage", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/ingest/storage", payload, headers })).statusCode).toBe(200);
  });

  it("won't let one agent complete another agent's quarantine command", async () => {
    const app = await buildApp({ logger: false });
    const owner = await seedAuthedAgent();
    const intruder = await seedAuthedAgent();
    const alert = await prisma.alert.create({
      data: { type: "SENSITIVE_DATA_EXPOSED", severity: "HIGH", message: "t", agentId: owner.agent.id, metadata: { path: "/tmp/test/x" } },
    });
    const action = await prisma.responseAction.create({ data: { alertId: alert.id, type: "FILE_QUARANTINE", status: "APPROVED" } });

    const res = await app.inject({
      method: "POST",
      url: `/agent-commands/${action.id}/complete`,
      payload: { agentKey: intruder.agent.key, success: true, message: "done" },
      headers: intruder.headers,
    });
    expect(res.statusCode).toBe(404);
    expect((await prisma.responseAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("APPROVED");
  });
});

describe("revoking an agent", () => {
  it("cuts off ingest and blocks re-registration until restored", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAs(app, "ADMIN");
    const payload = registerPayload();
    const { id, agentSecret } = (await app.inject({ method: "POST", url: "/agents/register", payload, headers: enroll })).json();

    const revoke = await app.inject({ method: "POST", url: `/agents/${id}/revoke`, headers: { cookie } });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revokedAt).not.toBeNull();

    const ingest = await app.inject({
      method: "POST",
      url: "/ingest/events",
      payload: [event(payload.key)],
      headers: { authorization: `Bearer ${agentSecret}` },
    });
    expect(ingest.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/agents/register", payload, headers: enroll })).statusCode).toBe(403);

    await app.inject({ method: "POST", url: `/agents/${id}/restore`, headers: { cookie } });
    const again = await app.inject({ method: "POST", url: "/agents/register", payload, headers: enroll });
    expect(again.statusCode).toBe(200);
    expect(again.json().agentSecret).not.toBe(agentSecret);
  });

  it("is ADMIN-only", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAs(app, "VIEWER");
    const { agent } = await seedAuthedAgent();
    const res = await app.inject({ method: "POST", url: `/agents/${agent.id}/revoke`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).revokedAt).toBeNull();
  });

  it("never exposes secretHash from GET /agents", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAs(app, "VIEWER");
    await seedAuthedAgent();
    const res = await app.inject({ method: "GET", url: "/agents", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).not.toHaveProperty("secretHash");
  });
});

describe("agent installer", () => {
  // The installer itself isn't secret, but the enroll token served beside it
  // is the credential that lets a machine register. Handing it to every
  // VIEWER who opens the Agents page would undo the point of having roles.
  it("keeps the installer and the enroll token to ADMINs", async () => {
    const app = await buildApp();
    const viewer = await loginAs(app, "VIEWER");

    for (const url of ["/agents/installer-info", "/agents/installer"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: viewer } });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it("refuses both without a session at all", async () => {
    const app = await buildApp();
    for (const url of ["/agents/installer-info", "/agents/installer"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    await app.close();
  });

  it("gives an ADMIN the enroll token, so the dashboard can show a command that works", async () => {
    const app = await buildApp();
    const admin = await loginAs(app, "ADMIN");

    const res = await app.inject({ method: "GET", url: "/agents/installer-info", headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    expect(res.json().enrollToken).toBe(process.env.AGENT_ENROLL_TOKEN);
    await app.close();
  });

  // A deployment that hasn't had an agent build dropped in should say so
  // rather than serve an empty file that fails mysteriously on Windows.
  it("reports plainly when no build is available", async () => {
    const app = await buildApp();
    const admin = await loginAs(app, "ADMIN");

    const info = await app.inject({ method: "GET", url: "/agents/installer-info", headers: { cookie: admin } });
    const download = await app.inject({ method: "GET", url: "/agents/installer", headers: { cookie: admin } });

    // The test environment has no installer mounted, which is the case here.
    if (!info.json().available) {
      expect(download.statusCode).toBe(404);
      expect(download.json().error).toContain("no agent build");
    } else {
      expect(download.statusCode).toBe(200);
    }
    await app.close();
  });
});

describe("DELETE /agents/:id", () => {
  async function seedRevokedAgent(hostname = "OLD-AGENT") {
    const agent = await prisma.agent.create({
      data: { key: `agent-${randomUUID()}`, hostname, watchedRoot: "C:\\Users\\x\\Downloads", revokedAt: new Date() },
    });
    const source = await prisma.source.create({
      data: { kind: "LOCAL", rootLabel: agent.watchedRoot, agentId: agent.id },
    });
    await prisma.fileEvent.create({
      data: { agentId: agent.id, sourceId: source.id, eventType: "CREATED", path: "C:\\x.txt", occurredAt: new Date() },
    });
    return { agent, source };
  }

  it("removes a revoked agent and the history it collected", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const { agent, source } = await seedRevokedAgent();

    const res = await app.inject({ method: "DELETE", url: `/agents/${agent.id}`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted.fileEvents).toBe(1);
    expect(await prisma.agent.findUnique({ where: { id: agent.id } })).toBeNull();
    expect(await prisma.source.findUnique({ where: { id: source.id } })).toBeNull();
    await app.close();
  });

  // A running agent would register again on its next request, leaving a row
  // that reappears seconds after someone deleted it.
  it("refuses to delete an agent that hasn't been revoked", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await prisma.agent.create({
      data: { key: `agent-${randomUUID()}`, hostname: "LIVE", watchedRoot: "/data" },
    });

    const res = await app.inject({ method: "DELETE", url: `/agents/${agent.id}`, headers: { cookie } });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("revoke the agent first");
    await app.close();
  });

  it("is ADMIN-only", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "VIEWER");
    const { agent } = await seedRevokedAgent();

    const res = await app.inject({ method: "DELETE", url: `/agents/${agent.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // A share's history belongs to the file server, not to whoever was scanning
  // it — deleting a stale agent must not take it along.
  it("won't delete an agent that reported a share's history", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const { agent } = await seedRevokedAgent("SCANNER");
    const server = await prisma.fileServer.create({
      data: { name: `fs-${randomUUID()}`, host: "fs", username: "u", passwordEnc: "x" },
    });
    const share = await prisma.source.create({
      data: { kind: "SMB", rootLabel: "smb://fs/share", fileServerId: server.id, shareName: "share", agentId: agent.id },
    });
    await prisma.fileEvent.create({
      data: { agentId: agent.id, sourceId: share.id, eventType: "CREATED", path: "a.txt", occurredAt: new Date() },
    });

    const res = await app.inject({ method: "DELETE", url: `/agents/${agent.id}`, headers: { cookie } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("reassign those shares");
    expect(await prisma.agent.findUnique({ where: { id: agent.id } })).not.toBeNull();
    await app.close();
  });

  it("unassigns shares it scanned but never reported for, keeping them", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const { agent } = await seedRevokedAgent("IDLE-SCANNER");
    const server = await prisma.fileServer.create({
      data: { name: `fs-${randomUUID()}`, host: "fs", username: "u", passwordEnc: "x" },
    });
    const share = await prisma.source.create({
      data: { kind: "SMB", rootLabel: "smb://fs/idle", fileServerId: server.id, shareName: "idle", agentId: agent.id },
    });

    const res = await app.inject({ method: "DELETE", url: `/agents/${agent.id}`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const kept = await prisma.source.findUnique({ where: { id: share.id } });
    expect(kept).not.toBeNull();
    expect(kept?.agentId).toBeNull();
    await app.close();
  });

  it("records the deletion, since it destroys audit history", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const { agent } = await seedRevokedAgent("AUDITED");

    await app.inject({ method: "DELETE", url: `/agents/${agent.id}`, headers: { cookie } });
    const audit = await prisma.auditLog.findFirst({ where: { targetId: agent.id, action: "agent.delete" } });

    expect(audit).not.toBeNull();
    await app.close();
  });
});
