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

async function seedAgent(hostname = "WIN-TEST") {
  return prisma.agent.create({
    data: { key: `agent-${randomUUID()}`, hostname, watchedRoot: hostname },
  });
}

describe("POST /discovery/scans", () => {
  it("queues a scan for an agent to run", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await seedAgent();

    const res = await app.inject({
      method: "POST",
      url: "/discovery/scans",
      headers: { cookie },
      payload: { cidr: "20.20.5.0/24", agentId: agent.id },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("PENDING");
    expect(res.json().cidr).toBe("20.20.5.0/24");
    await app.close();
  });

  // The cap is the server's to enforce: a /16 is 65,536 addresses, minutes of
  // traffic, and looks exactly like a port sweep to anything watching.
  it("refuses a range too large to sweep, and says why", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await seedAgent();

    const res = await app.inject({
      method: "POST",
      url: "/discovery/scans",
      headers: { cookie },
      payload: { cidr: "20.20.0.0/16", agentId: agent.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("smaller range");
    await app.close();
  });

  it("is ADMIN-only — scanning a network is not a read-only act", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "VIEWER");
    const agent = await seedAgent();

    const res = await app.inject({
      method: "POST",
      url: "/discovery/scans",
      headers: { cookie },
      payload: { cidr: "20.20.5.0/24", agentId: agent.id },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("refuses to queue work for a revoked agent", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await prisma.agent.create({
      data: { key: `agent-${randomUUID()}`, hostname: "GONE", watchedRoot: "/x", revokedAt: new Date() },
    });

    const res = await app.inject({
      method: "POST",
      url: "/discovery/scans",
      headers: { cookie },
      payload: { cidr: "20.20.5.0/24", agentId: agent.id },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /discovery/coverage", () => {
  it("says which machines have an agent and which don't", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");
    const agent = await seedAgent("WIN-FS");

    const scan = await prisma.discoveryScan.create({
      data: {
        cidr: "20.20.5.0/24",
        agentId: agent.id,
        requestedBy: "admin@example.com",
        status: "SUCCEEDED",
        completedAt: new Date(),
        hosts: {
          create: [
            { address: "20.20.5.196", hostname: "win-fs.corp.local", openPorts: [445] },
            { address: "20.20.5.10", hostname: "LAPTOP-7", openPorts: [445, 3389] },
          ],
        },
      },
    });

    const res = await app.inject({ method: "GET", url: "/discovery/coverage", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scan.id).toBe(scan.id);

    const byAddress = Object.fromEntries(body.machines.map((m: { address: string }) => [m.address, m]));
    // Matched despite the scan seeing the fully qualified name.
    expect(byAddress["20.20.5.196"].state).toBe("protected");
    expect(byAddress["20.20.5.10"].state).toBe("unprotected");
    await app.close();
  });

  it("answers plainly when nothing has been scanned yet", async () => {
    const app = await buildApp();
    const cookie = await loginAs(app, "ADMIN");

    const res = await app.inject({ method: "GET", url: "/discovery/coverage", headers: { cookie } });
    expect(res.json()).toEqual({ scan: null, machines: [] });
    await app.close();
  });
});
