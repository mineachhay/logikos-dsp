import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";

async function loginAs(app: FastifyInstance, role: "ADMIN" | "VIEWER"): Promise<string> {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const password = "correct-password-123";
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "token")!;
  return `${cookie.name}=${cookie.value}`;
}

async function seedAgent(capabilities = ["managed-sources"]) {
  return prisma.agent.create({
    data: { key: `agent-${randomUUID()}`, hostname: "dsp-agent", watchedRoot: "/data", capabilities },
  });
}

function payload(agentId: string, address = "20.20.5.14") {
  return { address, agentId, username: "Administrator", password: "hunter2", watchPath: "C:\\Users", allDrives: true, removable: true };
}

describe("POST /deployments", () => {
  it("queues a remote install", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await seedAgent();

    const res = await app.inject({ method: "POST", url: "/deployments", headers: { cookie }, payload: payload(agent.id) });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("PENDING");
    expect(res.json().username).toBe("Administrator");
    await app.close();
  });

  // The property this whole design exists for. A password column would make
  // this server worth attacking for its own sake.
  it("never writes the password to the database", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await seedAgent();

    const res = await app.inject({ method: "POST", url: "/deployments", headers: { cookie }, payload: payload(agent.id) });
    const stored = await prisma.deployment.findUniqueOrThrow({ where: { id: res.json().id } });

    expect(JSON.stringify(stored)).not.toContain("hunter2");
    await app.close();
  });

  it("is ADMIN-only", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "VIEWER");
    const agent = await seedAgent();

    const res = await app.inject({ method: "POST", url: "/deployments", headers: { cookie }, payload: payload(agent.id) });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("refuses an agent that can't deploy", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await seedAgent([]);

    const res = await app.inject({ method: "POST", url: "/deployments", headers: { cookie }, payload: payload(agent.id) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("can't deploy");
    await app.close();
  });

  // Two installs racing on one target end with a service half-configured by each.
  it("refuses a second deployment to a machine already being installed", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await seedAgent();

    await app.inject({ method: "POST", url: "/deployments", headers: { cookie }, payload: payload(agent.id, "20.20.5.20") });
    const second = await app.inject({ method: "POST", url: "/deployments", headers: { cookie }, payload: payload(agent.id, "20.20.5.20") });

    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it("records who asked, so a remote install leaves a trail", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await seedAgent();

    const res = await app.inject({ method: "POST", url: "/deployments", headers: { cookie }, payload: payload(agent.id, "20.20.5.31") });
    const audit = await prisma.auditLog.findFirst({ where: { targetId: res.json().id } });

    expect(audit?.action).toBe("agent.deploy");
    expect(audit?.userEmail).toContain("admin-");
    await app.close();
  });
});
