import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { MANAGED_SOURCES_CAPABILITY } from "@logikos-dsp/shared";
import { encryptSecret } from "@logikos-dsp/shared/credentials";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { seedAuthedAgent } from "../auth/agentFixtures.testutil.js";

async function adminCookie(app: FastifyInstance): Promise<string> {
  const email = `admin-${randomUUID()}@example.com`;
  const password = "correct-password-123";
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: "ADMIN" } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "token")!;
  return `${cookie.name}=${cookie.value}`;
}

/** A Windows file server with activity collection on, one share, assigned to a managed agent. */
async function setup(options: { activityEnabled?: boolean; winrm?: { username: string; password: string } } = {}) {
  const app = await buildApp({ logger: false });
  const seeded = await seedAuthedAgent();
  await prisma.agent.update({ where: { id: seeded.agent.id }, data: { capabilities: [MANAGED_SOURCES_CAPABILITY] } });
  const server = await prisma.fileServer.create({
    data: {
      name: `win-${randomUUID().slice(0, 6)}`,
      host: "20.20.5.196",
      username: "svc-dsp",
      passwordEnc: encryptSecret("share-password"),
      activityEnabled: options.activityEnabled ?? true,
      winrmUsername: options.winrm?.username ?? null,
      winrmPasswordEnc: options.winrm ? encryptSecret(options.winrm.password) : null,
    },
  });
  const share = await prisma.source.create({
    data: {
      kind: "SMB",
      rootLabel: "smb://20.20.5.196/share",
      fileServerId: server.id,
      shareName: "share",
      subPath: "",
      agentId: seeded.agent.id,
      scanIntervalSec: 60,
    },
  });
  return { app, seeded, server, share };
}

function activityPayload(agentKey: string, fileServerId: string, over: object = {}) {
  return {
    agentKey,
    fileServerId,
    bookmark: 1200,
    records: [
      {
        sourceId: undefined as string | undefined,
        path: "payroll.csv",
        action: "WRITE",
        userName: "jdoe",
        userDomain: "CORP",
        clientIp: "10.0.0.42",
        occurredAt: new Date().toISOString(),
        recordId: 1200,
      },
    ],
    ...over,
  };
}

describe("POST /ingest/activity", () => {
  it("needs agent credentials, and refuses a file server none of whose shares this agent holds", async () => {
    const { app, seeded, server } = await setup();
    const stranger = await seedAuthedAgent();

    const noAuth = await app.inject({ method: "POST", url: "/ingest/activity", payload: activityPayload(seeded.agent.key, server.id) });
    expect(noAuth.statusCode).toBe(401);

    const wrongAgent = await app.inject({
      method: "POST",
      url: "/ingest/activity",
      headers: stranger.headers,
      payload: activityPayload(stranger.agent.key, server.id),
    });
    expect(wrongAgent.statusCode).toBe(403);
  });

  it("stores records, ignores a re-poll of the same Windows record, and tracks the bookmark", async () => {
    const { app, seeded, server, share } = await setup();
    const payload = activityPayload(seeded.agent.key, server.id);
    payload.records[0].sourceId = share.id;

    const first = await app.inject({ method: "POST", url: "/ingest/activity", headers: seeded.headers, payload });
    expect(first.json()).toMatchObject({ stored: 1 });
    const second = await app.inject({ method: "POST", url: "/ingest/activity", headers: seeded.headers, payload });
    expect(second.json()).toMatchObject({ stored: 0 });

    expect(await prisma.fileActivity.count()).toBe(1);
    const updated = await prisma.fileServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(Number(updated.activityBookmark)).toBe(1200);
    expect(updated.lastActivityAt).not.toBeNull();
    expect(updated.lastActivityError).toBeNull();
  });

  it("records a collection failure so the dashboard can show it", async () => {
    const { app, seeded, server } = await setup();
    await app.inject({
      method: "POST",
      url: "/ingest/activity",
      headers: seeded.headers,
      payload: activityPayload(seeded.agent.key, server.id, { records: [], error: "WinRMTransportError: 401" }),
    });
    expect((await prisma.fileServer.findUniqueOrThrow({ where: { id: server.id } })).lastActivityError).toContain("401");
  });
});

describe("matching who to what", () => {
  it("fills in the actor when the file event arrives first", async () => {
    const { app, seeded, server, share } = await setup();
    const changedAt = new Date();

    await app.inject({
      method: "POST",
      url: "/ingest/activity",
      headers: seeded.headers,
      payload: {
        ...activityPayload(seeded.agent.key, server.id),
        records: [
          {
            sourceId: share.id,
            path: "payroll.csv",
            action: "WRITE",
            userName: "jdoe",
            userDomain: "CORP",
            clientIp: "10.0.0.42",
            occurredAt: changedAt.toISOString(),
            recordId: 900,
          },
        ],
      },
    });

    // The scan notices the change 40s later, as a scan would.
    const res = await app.inject({
      method: "POST",
      url: "/ingest/events",
      headers: seeded.headers,
      payload: [
        {
          agentKey: seeded.agent.key,
          sourceId: share.id,
          eventType: "created",
          path: "payroll.csv",
          occurredAt: new Date(changedAt.getTime() + 40_000).toISOString(),
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const event = await prisma.fileEvent.findFirstOrThrow();
    expect(event.actorUser).toBe("CORP\\jdoe");
    expect(event.actorIp).toBe("10.0.0.42");
  });

  it("backfills events that were recorded before their audit record arrived", async () => {
    const { app, seeded, server, share } = await setup();
    const changedAt = new Date();
    await prisma.fileEvent.create({
      data: {
        agentId: seeded.agent.id,
        sourceId: share.id,
        eventType: "DELETED",
        path: "secret.docx",
        occurredAt: new Date(changedAt.getTime() + 30_000),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ingest/activity",
      headers: seeded.headers,
      payload: {
        ...activityPayload(seeded.agent.key, server.id),
        records: [
          {
            sourceId: share.id,
            path: "secret.docx",
            action: "DELETE",
            userName: "mallory",
            occurredAt: changedAt.toISOString(),
            recordId: 950,
          },
        ],
      },
    });
    expect(res.json()).toMatchObject({ matched: 1 });
    expect((await prisma.fileEvent.findFirstOrThrow()).actorUser).toBe("mallory");
  });

  it("attributes a rename, which Windows logs as a delete of the old name", async () => {
    const { app, seeded, server, share } = await setup();
    const renamedAt = new Date();

    await app.inject({
      method: "POST",
      url: "/ingest/activity",
      headers: seeded.headers,
      payload: {
        ...activityPayload(seeded.agent.key, server.id),
        records: [
          {
            sourceId: share.id,
            path: "new file.txt",
            action: "DELETE",
            userName: "Administrator",
            userDomain: "WIN-FS",
            occurredAt: renamedAt.toISOString(),
            recordId: 970,
          },
        ],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ingest/events",
      headers: seeded.headers,
      payload: [
        {
          agentKey: seeded.agent.key,
          sourceId: share.id,
          eventType: "renamed",
          path: "new rename file name.txt",
          previousPath: "new file.txt",
          occurredAt: new Date(renamedAt.getTime() + 47_000).toISOString(),
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const event = await prisma.fileEvent.findFirstOrThrow({ where: { eventType: "RENAMED" } });
    expect(event.actorUser).toBe("WIN-FS\\Administrator");
  });

  it("doesn't attribute a change to someone who only read the file", async () => {
    const { app, seeded, server, share } = await setup();
    const now = new Date();
    await prisma.fileEvent.create({
      data: { agentId: seeded.agent.id, sourceId: share.id, eventType: "MODIFIED", path: "report.csv", occurredAt: now },
    });
    await app.inject({
      method: "POST",
      url: "/ingest/activity",
      headers: seeded.headers,
      payload: {
        ...activityPayload(seeded.agent.key, server.id),
        records: [
          { sourceId: share.id, path: "report.csv", action: "READ", userName: "reader", occurredAt: new Date(now.getTime() - 5000).toISOString(), recordId: 960 },
        ],
      },
    });
    expect((await prisma.fileEvent.findFirstOrThrow()).actorUser).toBeNull();
  });
});

describe("renames between two scans", () => {
  it("turns an unexplained create into a rename when only the old name was logged as deleted", async () => {
    const { app, seeded, server, share } = await setup();
    const renamedAt = new Date();

    // The scan sees only the new name: the file was created and renamed inside one interval.
    await app.inject({
      method: "POST",
      url: "/ingest/events",
      headers: seeded.headers,
      payload: [
        {
          agentKey: seeded.agent.key,
          sourceId: share.id,
          eventType: "created",
          path: "HR/rename file.txt",
          occurredAt: new Date(renamedAt.getTime() + 20_000).toISOString(),
        },
      ],
    });

    await app.inject({
      method: "POST",
      url: "/ingest/activity",
      headers: seeded.headers,
      payload: {
        ...activityPayload(seeded.agent.key, server.id),
        records: [
          {
            sourceId: share.id,
            path: "HR/rename dsp file updated.txt",
            action: "DELETE",
            userName: "Administrator",
            userDomain: "WIN-FS",
            occurredAt: renamedAt.toISOString(),
            recordId: 980,
          },
        ],
      },
    });

    const event = await prisma.fileEvent.findFirstOrThrow();
    expect(event.eventType).toBe("RENAMED");
    expect(event.previousPath).toBe("HR/rename dsp file updated.txt");
    expect(event.actorUser).toBe("WIN-FS\\Administrator");
  });

  it("leaves a genuine delete and a genuine create alone", async () => {
    const { app, seeded, server, share } = await setup();
    const at = new Date();
    await app.inject({
      method: "POST",
      url: "/ingest/events",
      headers: seeded.headers,
      payload: [
        { agentKey: seeded.agent.key, sourceId: share.id, eventType: "deleted", path: "HR/gone.txt", occurredAt: at.toISOString() },
        { agentKey: seeded.agent.key, sourceId: share.id, eventType: "created", path: "HR/fresh.txt", occurredAt: at.toISOString() },
      ],
    });
    await app.inject({
      method: "POST",
      url: "/ingest/activity",
      headers: seeded.headers,
      payload: {
        ...activityPayload(seeded.agent.key, server.id),
        records: [
          { sourceId: share.id, path: "HR/gone.txt", action: "DELETE", userName: "Administrator", occurredAt: at.toISOString(), recordId: 990 },
        ],
      },
    });

    const created = await prisma.fileEvent.findFirstOrThrow({ where: { path: "HR/fresh.txt" } });
    expect(created.eventType).toBe("CREATED");
    expect(created.previousPath).toBeNull();
    // The delete record explains the deletion it belongs to, not the unrelated create.
    expect((await prisma.fileEvent.findFirstOrThrow({ where: { path: "HR/gone.txt" } })).actorUser).toBe("Administrator");
  });
});

describe("collector config over /agent-sync", () => {
  it("hands the agent the WinRM account, falling back to the share account", async () => {
    const { app, seeded, server, share } = await setup();
    const sync = await app.inject({ method: "GET", url: `/agent-sync?agentKey=${seeded.agent.key}`, headers: seeded.headers });
    expect(sync.json().activityCollectors).toEqual([
      {
        fileServerId: server.id,
        host: "20.20.5.196",
        winrmPort: 5985,
        username: "svc-dsp",
        password: "share-password",
        recordReads: false,
        bookmark: null,
        shares: [{ sourceId: share.id, shareName: "share", subPath: "" }],
      },
    ]);
  });

  it("uses a separate WinRM account when one is set", async () => {
    const { app, seeded } = await setup({ winrm: { username: "CORP\\svc-eventlog", password: "winrm-password" } });
    const collector = (await app.inject({ method: "GET", url: `/agent-sync?agentKey=${seeded.agent.key}`, headers: seeded.headers })).json()
      .activityCollectors[0];
    expect(collector).toMatchObject({ username: "CORP\\svc-eventlog", password: "winrm-password" });
  });

  it("sends nothing while collection is off", async () => {
    const { app, seeded } = await setup({ activityEnabled: false });
    expect((await app.inject({ method: "GET", url: `/agent-sync?agentKey=${seeded.agent.key}`, headers: seeded.headers })).json().activityCollectors).toEqual([]);
  });
});

describe("file server activity settings", () => {
  it("never returns the WinRM password, only whether one is stored", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await adminCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/file-servers",
      headers: { cookie },
      payload: {
        name: "win-fs",
        host: "20.20.5.196",
        username: "svc-dsp",
        password: "share-password",
        activityEnabled: true,
        winrmUsername: "svc-eventlog",
        winrmPassword: "winrm-secret-password",
      },
    });
    expect(created.statusCode).toBe(201);

    const listed = (await app.inject({ method: "GET", url: "/file-servers", headers: { cookie } })).json();
    expect(JSON.stringify(listed)).not.toContain("winrm-secret-password");
    expect(listed[0]).toMatchObject({ activityEnabled: true, winrmUsername: "svc-eventlog", hasWinrmPassword: true });

    // Blank on edit keeps the stored password, like the share password does.
    await app.inject({ method: "PATCH", url: `/file-servers/${listed[0].id}`, headers: { cookie }, payload: { winrmPort: 5986 } });
    const row = await prisma.fileServer.findUniqueOrThrow({ where: { id: listed[0].id } });
    expect(row.winrmPasswordEnc).not.toBeNull();
    expect(row.winrmPort).toBe(5986);
    const audit = await prisma.auditLog.findMany({ where: { targetId: listed[0].id } });
    expect(JSON.stringify(audit)).not.toContain("winrm-secret-password");
  });
});
