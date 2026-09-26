import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { SESSION_TTL_SECONDS } from "../auth/sessions.js";

const PASSWORD = "correct-horse-battery-9";

async function seedUser(role: "ADMIN" | "VIEWER", password = PASSWORD) {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role } });
  return { ...user, password };
}

async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "token")!;
  return `token=${cookie.value}`;
}

function call(app: FastifyInstance, cookie: string, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, payload });
}

function claims(cookie: string): Record<string, number> {
  return JSON.parse(Buffer.from(cookie.split(".")[1]!, "base64url").toString());
}

describe("sessions", () => {
  it("ends a deactivated user's existing session immediately", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const other = await seedUser("ADMIN");
    const adminCookie = await login(app, admin.email);
    const otherCookie = await login(app, other.email);
    expect((await call(app, otherCookie, "GET", "/users")).statusCode).toBe(200);

    await call(app, adminCookie, "PATCH", `/users/${other.id}`, { isActive: false });
    expect((await call(app, otherCookie, "GET", "/users")).statusCode).toBe(401);
  });

  it("applies a demotion on the next request, not the next login", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const other = await seedUser("ADMIN");
    const adminCookie = await login(app, admin.email);
    const otherCookie = await login(app, other.email);

    await call(app, adminCookie, "PATCH", `/users/${other.id}`, { role: "VIEWER" });
    expect((await call(app, otherCookie, "GET", "/users")).statusCode).toBe(403);
    expect((await call(app, otherCookie, "GET", "/alerts")).statusCode).toBe(200);
  });

  it("issues tokens that expire, in a cookie that does too", async () => {
    const app = await buildApp({ logger: false });
    const user = await seedUser("VIEWER");
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: user.email, password: PASSWORD } });
    const cookie = res.cookies.find((c) => c.name === "token")!;
    const { iat, exp } = claims(`token=${cookie.value}`);
    expect(exp - iat).toBe(SESSION_TTL_SECONDS);
    expect(cookie.maxAge).toBe(SESSION_TTL_SECONDS);
  });

  it("renews an active session's token once it's old enough", async () => {
    const app = await buildApp({ logger: false });
    const user = await seedUser("VIEWER");
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    const old = app.jwt.sign({ id: user.id, email: user.email, role: user.role, sv: 0, iat: hourAgo });
    const res = await call(app, `token=${old}`, "GET", "/auth/me");
    expect(res.statusCode).toBe(200);
    const renewed = res.cookies.find((c) => c.name === "token");
    expect(renewed).toBeDefined();
    expect(claims(`token=${renewed!.value}`).iat).toBeGreaterThan(hourAgo);
  });

  it("rejects a token from before sessions were versioned", async () => {
    const app = await buildApp({ logger: false });
    const user = await seedUser("ADMIN");
    const legacy = app.jwt.sign({ id: user.id, email: user.email, role: user.role } as never);
    expect((await call(app, `token=${legacy}`, "GET", "/auth/me")).statusCode).toBe(401);
  });

  it("signs a user out everywhere on request", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const viewer = await seedUser("VIEWER");
    const adminCookie = await login(app, admin.email);
    const viewerCookie = await login(app, viewer.email);
    await call(app, adminCookie, "POST", `/users/${viewer.id}/sessions/revoke`);
    expect((await call(app, viewerCookie, "GET", "/alerts")).statusCode).toBe(401);
    await login(app, viewer.email); // and can simply log in again
  });
});

describe("passwords", () => {
  it("changes your own password, ending your other sessions but not this one", async () => {
    const app = await buildApp({ logger: false });
    const user = await seedUser("VIEWER");
    const here = await login(app, user.email);
    const elsewhere = await login(app, user.email);

    expect((await call(app, here, "POST", "/auth/password", { currentPassword: "wrong", newPassword: "another-good-pass-42" })).statusCode).toBe(400);
    const weak = await call(app, here, "POST", "/auth/password", { currentPassword: PASSWORD, newPassword: "short" });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toMatch(/at least 12/);

    const ok = await call(app, here, "POST", "/auth/password", { currentPassword: PASSWORD, newPassword: "another-good-pass-42" });
    expect(ok.statusCode).toBe(200);
    const renewed = `token=${ok.cookies.find((c) => c.name === "token")!.value}`;
    expect((await call(app, renewed, "GET", "/alerts")).statusCode).toBe(200);
    expect((await call(app, elsewhere, "GET", "/alerts")).statusCode).toBe(401);
    await login(app, user.email, "another-good-pass-42");
  });

  it("makes a user change an admin-reset password before doing anything else", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const viewer = await seedUser("VIEWER");
    const adminCookie = await login(app, admin.email);

    const reset = await call(app, adminCookie, "POST", `/users/${viewer.id}/password`, { newPassword: "temporary-pass-2026" });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ mustChangePassword: true });

    const cookie = await login(app, viewer.email, "temporary-pass-2026");
    expect((await call(app, cookie, "GET", "/auth/me")).json()).toMatchObject({ mustChangePassword: true });
    const blocked = await call(app, cookie, "GET", "/alerts");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("PASSWORD_CHANGE_REQUIRED");

    const changed = await call(app, cookie, "POST", "/auth/password", { currentPassword: "temporary-pass-2026", newPassword: "my-own-choice-2026" });
    const fresh = `token=${changed.cookies.find((c) => c.name === "token")!.value}`;
    expect((await call(app, fresh, "GET", "/alerts")).statusCode).toBe(200);
  });

  it("applies the password rules when an admin creates a user", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const cookie = await login(app, admin.email);
    const res = await call(app, cookie, "POST", "/users", { email: "new@example.com", password: "password1234" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/too common/);
  });
});

describe("user management", () => {
  it("won't let an admin deactivate or demote themselves", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const cookie = await login(app, admin.email);
    expect((await call(app, cookie, "PATCH", `/users/${admin.id}`, { isActive: false })).statusCode).toBe(400);
    expect((await call(app, cookie, "PATCH", `/users/${admin.id}`, { role: "VIEWER" })).statusCode).toBe(400);
  });

  it("treats email case-insensitively", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const cookie = await login(app, admin.email);
    const tag = randomUUID().slice(0, 8);
    const created = await call(app, cookie, "POST", "/users", { email: `Mixed.${tag}@Example.COM`, password: "a-decent-password-1" });
    expect(created.json().email).toBe(`mixed.${tag}@example.com`);
    expect((await call(app, cookie, "POST", "/users", { email: `MIXED.${tag}@example.com`, password: "a-decent-password-1" })).statusCode).toBe(409);
    await login(app, `MIXED.${tag}@EXAMPLE.com`, "a-decent-password-1");
  });

  it("unlocks a locked account early", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const viewer = await seedUser("VIEWER");
    await prisma.user.update({ where: { id: viewer.id }, data: { failedLoginCount: 7, lockedUntil: new Date(Date.now() + 3600_000) } });
    const cookie = await login(app, admin.email);
    const res = await call(app, cookie, "POST", `/users/${viewer.id}/unlock`);
    expect(res.json()).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    await login(app, viewer.email);
  });

  it("audits every change, and never the password itself", async () => {
    const app = await buildApp({ logger: false });
    const admin = await seedUser("ADMIN");
    const cookie = await login(app, admin.email);
    const created = (await call(app, cookie, "POST", "/users", { email: `aud-${randomUUID()}@example.com`, password: "audited-pass-2026" })).json();
    await call(app, cookie, "PATCH", `/users/${created.id}`, { role: "ADMIN" });
    await call(app, cookie, "POST", `/users/${created.id}/password`, { newPassword: "reset-by-admin-2026" });

    const entries = await prisma.auditLog.findMany({ where: { targetId: created.id }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => e.action)).toEqual(["user.create", "user.update", "user.password.reset"]);
    expect(entries[1]!.details).toMatchObject({ role: { from: "VIEWER", to: "ADMIN" } });
    expect(entries.every((e) => e.userEmail === admin.email)).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/audited-pass|reset-by-admin/);
  });
});
