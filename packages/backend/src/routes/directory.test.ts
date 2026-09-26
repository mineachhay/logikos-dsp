import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

// The LDAP side is exercised against a real Samba AD DC (see ARCHITECTURE.md);
// here it's stubbed so the sign-in rules around it can be tested exactly.
vi.mock("../auth/directoryClient.js", () => ({
  loadDirectoryConfig: vi.fn(),
  authenticateDirectory: vi.fn(),
  recheckDirectoryAccount: vi.fn(),
  testDirectory: vi.fn(),
}));

import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import * as directory from "../auth/directoryClient.js";

const cfg = {
  domain: "corp.example",
  servers: ["dc1.corp.example"],
  port: 636,
  baseDn: "DC=corp,DC=example",
  bindUsername: "svc-dsp",
  bindPassword: "x",
  caCertPem: "",
  adminGroup: "DSP-Admins",
  viewerGroup: "DSP-Viewers",
};

function account(role: "ADMIN" | "VIEWER", name = "jdoe", guid = randomUUID()) {
  return { ok: true as const, account: { guid, dn: `CN=${name},CN=Users,DC=corp,DC=example`, email: `${name}@corp.example`, displayName: name, role } };
}

async function signIn(app: FastifyInstance, email: string, password = "windows-password") {
  return app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `token=${res.cookies.find((c) => c.name === "token")!.value}`;
}

beforeEach(() => {
  vi.mocked(directory.loadDirectoryConfig).mockResolvedValue(cfg);
  vi.mocked(directory.authenticateDirectory).mockReset();
  vi.mocked(directory.recheckDirectoryAccount).mockReset();
});

describe("directory sign-in", () => {
  it("creates the account on first sign-in, with the role from AD", async () => {
    const app = await buildApp({ logger: false });
    const name = `u${randomUUID().slice(0, 8)}`;
    vi.mocked(directory.authenticateDirectory).mockResolvedValue(account("VIEWER", name));

    const res = await signIn(app, `CORP\\${name}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: `${name}@corp.example`, role: "VIEWER", source: "DIRECTORY" });
    const audit = await prisma.auditLog.findFirst({ where: { action: "user.create", userEmail: "active-directory" }, orderBy: { createdAt: "desc" } });
    expect(audit?.details).toMatchObject({ email: `${name}@corp.example`, source: "DIRECTORY" });
  });

  it("matches the same person by objectGUID and follows role changes in AD", async () => {
    const app = await buildApp({ logger: false });
    const name = `u${randomUUID().slice(0, 8)}`;
    const guid = randomUUID();
    vi.mocked(directory.authenticateDirectory).mockResolvedValue(account("VIEWER", name, guid));
    await signIn(app, name);
    vi.mocked(directory.authenticateDirectory).mockResolvedValue(account("ADMIN", name, guid));
    expect((await signIn(app, name)).json().role).toBe("ADMIN");
    expect(await prisma.user.count({ where: { directoryGuid: guid } })).toBe(1);
  });

  it("never attaches an AD account to a local account with the same address", async () => {
    const app = await buildApp({ logger: false });
    const name = `u${randomUUID().slice(0, 8)}`;
    await prisma.user.create({ data: { email: `${name}@corp.example`, passwordHash: await hashPassword("local-only-pass-1"), role: "ADMIN" } });
    vi.mocked(directory.authenticateDirectory).mockResolvedValue(account("VIEWER", name));
    // Typed as a Windows name, so it isn't the local account's own sign-in.
    expect((await signIn(app, `CORP\\${name}`)).statusCode).toBe(401);
    expect(await prisma.user.count({ where: { email: `${name}@corp.example` } })).toBe(1);
  });

  it("keeps the local admin working without asking AD (break-glass)", async () => {
    const app = await buildApp({ logger: false });
    const email = `local-${randomUUID()}@example.com`;
    await prisma.user.create({ data: { email, passwordHash: await hashPassword("break-glass-pass-1"), role: "ADMIN" } });
    expect((await signIn(app, email, "break-glass-pass-1")).statusCode).toBe(200);
    expect(directory.authenticateDirectory).not.toHaveBeenCalled();
  });

  it("answers the same as a wrong password for anyone AD turns away, and 503 when AD is down", async () => {
    const app = await buildApp({ logger: false });
    for (const reason of ["not_found", "bad_password", "disabled", "no_group"] as const) {
      vi.mocked(directory.authenticateDirectory).mockResolvedValueOnce({ ok: false, reason });
      const res = await signIn(app, "someone");
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid email or password" });
    }
    vi.mocked(directory.authenticateDirectory).mockResolvedValueOnce({ ok: false, reason: "unavailable", detail: "timeout" });
    expect((await signIn(app, "someone")).statusCode).toBe(503);
  });

  it("refuses someone deactivated here even if AD would let them in", async () => {
    const app = await buildApp({ logger: false });
    const name = `u${randomUUID().slice(0, 8)}`;
    const guid = randomUUID();
    vi.mocked(directory.authenticateDirectory).mockResolvedValue(account("VIEWER", name, guid));
    await signIn(app, name);
    await prisma.user.update({ where: { directoryGuid: guid }, data: { isActive: false } });
    expect((await signIn(app, name)).statusCode).toBe(401);
  });
});

describe("directory accounts after sign-in", () => {
  async function directoryUser(app: FastifyInstance, role: "ADMIN" | "VIEWER") {
    const name = `u${randomUUID().slice(0, 8)}`;
    const guid = randomUUID();
    vi.mocked(directory.authenticateDirectory).mockResolvedValue(account(role, name, guid));
    const res = await signIn(app, name);
    return { cookie: cookieOf(res), id: res.json().id as string, guid };
  }

  async function ageSession(app: FastifyInstance, id: string) {
    // A token issued an hour ago, as after an hour of activity: the next request renews it.
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    const iat = Math.floor(Date.now() / 1000) - 3600;
    return `token=${app.jwt.sign({ id, email: user.email, role: user.role, sv: user.sessionVersion, iat })}`;
  }

  it("ends every session once AD says the account is disabled", async () => {
    const app = await buildApp({ logger: false });
    const { id } = await directoryUser(app, "VIEWER");
    const other = await directoryUser(app, "VIEWER"); // unrelated user stays in
    vi.mocked(directory.recheckDirectoryAccount).mockResolvedValue({ state: "disabled" });
    const aged = await ageSession(app, id);
    expect((await app.inject({ method: "GET", url: "/alerts", headers: { cookie: aged } })).statusCode).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).sessionVersion).toBe(1);
    expect((await app.inject({ method: "GET", url: "/alerts", headers: { cookie: other.cookie } })).statusCode).toBe(200);
  });

  it("applies a role change from AD at renewal, and keeps the session if AD is unreachable", async () => {
    const app = await buildApp({ logger: false });
    const { id } = await directoryUser(app, "ADMIN");
    vi.mocked(directory.recheckDirectoryAccount).mockResolvedValue({ state: "ok", role: "VIEWER", dn: "CN=x" });
    expect((await app.inject({ method: "GET", url: "/users", headers: { cookie: await ageSession(app, id) } })).statusCode).toBe(403);

    vi.mocked(directory.recheckDirectoryAccount).mockResolvedValue({ state: "unavailable", detail: "timeout" });
    expect((await app.inject({ method: "GET", url: "/alerts", headers: { cookie: await ageSession(app, id) } })).statusCode).toBe(200);
  });

  it("signs directory users out when directory sign-in is switched off", async () => {
    const app = await buildApp({ logger: false });
    const { id } = await directoryUser(app, "VIEWER");
    vi.mocked(directory.loadDirectoryConfig).mockResolvedValue(null);
    expect((await app.inject({ method: "GET", url: "/alerts", headers: { cookie: await ageSession(app, id) } })).statusCode).toBe(401);
  });

  it("leaves passwords and roles to AD", async () => {
    const app = await buildApp({ logger: false });
    const dirUser = await directoryUser(app, "VIEWER");
    const own = await app.inject({ method: "POST", url: "/auth/password", headers: { cookie: dirUser.cookie }, payload: { currentPassword: "x", newPassword: "another-good-pass-1" } });
    expect(own.statusCode).toBe(400);
    expect(own.json().error).toMatch(/Windows/);

    const admin = await directoryUser(app, "ADMIN");
    const reset = await app.inject({ method: "POST", url: `/users/${dirUser.id}/password`, headers: { cookie: admin.cookie }, payload: { newPassword: "temporary-pass-2026" } });
    expect(reset.statusCode).toBe(400);
    const role = await app.inject({ method: "PATCH", url: `/users/${dirUser.id}`, headers: { cookie: admin.cookie }, payload: { role: "ADMIN" } });
    expect(role.statusCode).toBe(400);
    const deactivate = await app.inject({ method: "PATCH", url: `/users/${dirUser.id}`, headers: { cookie: admin.cookie }, payload: { isActive: false } });
    expect(deactivate.statusCode).toBe(200);
  });
});

describe("directory settings", () => {
  it("stores the lookup password encrypted and never returns it", async () => {
    const app = await buildApp({ logger: false });
    const email = `admin-${randomUUID()}@example.com`;
    await prisma.user.create({ data: { email, passwordHash: await hashPassword("admin-pass-2026x"), role: "ADMIN" } });
    const cookie = cookieOf(await signIn(app, email, "admin-pass-2026x"));
    const body = {
      enabled: false,
      domain: "Corp.Example",
      servers: ["dc1.corp.example"],
      port: 636,
      bindUsername: "svc-dsp",
      bindPassword: "lookup-secret-123",
      caCertPem: "",
      adminGroup: "DSP-Admins",
      viewerGroup: "DSP-Viewers",
    };
    const saved = await app.inject({ method: "PUT", url: "/directory/settings", headers: { cookie }, payload: body });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ domain: "corp.example", hasBindPassword: true, effectiveBaseDn: "DC=corp,DC=example" });
    expect(JSON.stringify(saved.json())).not.toContain("lookup-secret-123");
    const row = await prisma.directorySettings.findUniqueOrThrow({ where: { id: "default" } });
    expect(row.bindPasswordEnc).not.toContain("lookup-secret-123");

    const badCa = await app.inject({ method: "PUT", url: "/directory/settings", headers: { cookie }, payload: { ...body, caCertPem: "not a cert" } });
    expect(badCa.statusCode).toBe(400);
    const incomplete = await app.inject({ method: "PUT", url: "/directory/settings", headers: { cookie }, payload: { ...body, enabled: true, adminGroup: "" } });
    expect(incomplete.json().error).toMatch(/admin group/);
  });
});
