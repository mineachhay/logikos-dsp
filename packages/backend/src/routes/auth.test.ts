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
