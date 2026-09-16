import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";

async function seedUser(role: "ADMIN" | "VIEWER", password = "correct-password-123") {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), role },
  });
  return { email, password };
}

async function login(app: FastifyInstance, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "token");
  return { res, cookieHeader: cookie ? `${cookie.name}=${cookie.value}` : undefined };
}

describe("auth routes", () => {
  it("logs in with correct credentials and sets an httpOnly cookie", async () => {
    const app = await buildApp({ logger: false });
    const { email, password } = await seedUser("ADMIN");

    const { res } = await login(app, email, password);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email, role: "ADMIN" });
    const cookie = res.cookies.find((c) => c.name === "token");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const app = await buildApp({ logger: false });
    const { email } = await seedUser("ADMIN");

    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "wrong-password" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects /auth/me without a session cookie", async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts /auth/me with a valid session cookie", async () => {
    const app = await buildApp({ logger: false });
    const { email, password } = await seedUser("VIEWER");
    const { cookieHeader } = await login(app, email, password);

    const res = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieHeader! } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email, role: "VIEWER" });
  });

  it("allows an ADMIN to patch an alert but forbids a VIEWER", async () => {
    const app = await buildApp({ logger: false });
    const alert = await prisma.alert.create({
      data: { type: "RANSOMWARE_RATE", severity: "CRITICAL", message: "test alert" },
    });

    const viewer = await seedUser("VIEWER");
    const { cookieHeader: viewerCookie } = await login(app, viewer.email, viewer.password);
    const viewerRes = await app.inject({
      method: "PATCH",
      url: `/alerts/${alert.id}`,
      headers: { cookie: viewerCookie! },
      payload: { status: "ACKNOWLEDGED" },
    });
    expect(viewerRes.statusCode).toBe(403);

    const admin = await seedUser("ADMIN");
    const { cookieHeader: adminCookie } = await login(app, admin.email, admin.password);
    const adminRes = await app.inject({
      method: "PATCH",
      url: `/alerts/${alert.id}`,
      headers: { cookie: adminCookie! },
      payload: { status: "ACKNOWLEDGED" },
    });
    expect(adminRes.statusCode).toBe(200);
  });
});

describe("brute-force protection", () => {
  async function failLogin(app: FastifyInstance, email: string, ip = "203.0.113.7") {
    return app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "wrong-password" }, remoteAddress: ip });
  }

  it("locks an account after repeated wrong passwords, then lets it back in when the lock expires", async () => {
    const app = await buildApp({ logger: false });
    const { email, password } = await seedUser("ADMIN");

    for (let i = 0; i < 4; i++) expect((await failLogin(app, email)).statusCode).toBe(401);
    // The fifth failure locks it; the next attempt is refused before the password is even checked.
    expect((await failLogin(app, email)).statusCode).toBe(401);

    const locked = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
    expect(locked.json().error).toMatch(/try again in \d+ seconds/);

    await prisma.user.update({ where: { email }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const after = await login(app, email, password);
    expect(after.res.statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });

  it("says the same thing whether or not the account exists, so it can't be used to find accounts", async () => {
    const app = await buildApp({ logger: false });
    const { email } = await seedUser("VIEWER");
    const real = await failLogin(app, email, "203.0.113.8");
    const fake = await failLogin(app, "nobody@example.com", "203.0.113.8");
    expect(real.statusCode).toBe(401);
    expect(fake.statusCode).toBe(401);
    expect(real.json()).toEqual(fake.json());
  });

  it("raises one alert when an account is locked, not one per attempt", async () => {
    const app = await buildApp({ logger: false });
    const { email } = await seedUser("ADMIN");
    for (let i = 0; i < 7; i++) await failLogin(app, email, "203.0.113.9");

    const alerts = await prisma.alert.findMany({ where: { type: "LOGIN_ATTACK" }, include: { responseActions: true } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("MEDIUM");
    expect(alerts[0].message).toContain(email);
    expect(alerts[0].responseActions.map((a) => a.type)).toEqual(["WEBHOOK_NOTIFICATION"]);
  });

  it("throttles one IP guessing across many accounts, which no single account's counter would catch", async () => {
    const app = await buildApp({ logger: false });
    const ip = "198.51.100.5";
    // 20 different usernames, so no account reaches its own lock threshold.
    for (let i = 0; i < 20; i++) await failLogin(app, `person-${i}@example.com`, ip);

    const blocked = await failLogin(app, "person-21@example.com", ip);
    expect(blocked.statusCode).toBe(429);

    // A different address is unaffected.
    const elsewhere = await failLogin(app, "person-21@example.com", "198.51.100.6");
    expect(elsewhere.statusCode).toBe(401);
  });

  it("doesn't lock an account out because of someone else's failures on another account", async () => {
    const app = await buildApp({ logger: false });
    const victim = await seedUser("ADMIN");
    const other = await seedUser("VIEWER");
    for (let i = 0; i < 5; i++) await failLogin(app, other.email, "203.0.113.10");

    const res = await login(app, victim.email, victim.password);
    expect(res.res.statusCode).toBe(200);
  });
});
