import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";

async function seedAdmin() {
  const email = `admin-${randomUUID()}@example.com`;
  const password = "correct-password-123";
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role: "ADMIN" } });
  return { email, password };
}

async function loginAsAdmin(app: FastifyInstance): Promise<string> {
  const { email, password } = await seedAdmin();
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "token")!;
  return `${cookie.name}=${cookie.value}`;
}

async function seedAlertWithAction(type: "WEBHOOK_NOTIFICATION" | "FILE_QUARANTINE") {
  const alert = await prisma.alert.create({
    data: { type: "SENSITIVE_DATA_EXPOSED", severity: "HIGH", message: "test alert", metadata: { path: "/tmp/test/file.txt" } },
  });
  const action = await prisma.responseAction.create({ data: { alertId: alert.id, type } });
  return { alert, action };
}

describe("POST /response-actions/:id/approve", () => {
  it("executes a webhook notification synchronously (unchanged behavior)", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAsAdmin(app);
    const { action } = await seedAlertWithAction("WEBHOOK_NOTIFICATION");

    const res = await app.inject({
      method: "POST",
      url: `/response-actions/${action.id}/approve`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(["EXECUTED", "FAILED"]).toContain(body.status);
    expect(body.executedAt).not.toBeNull();
  });

  it("marks a file quarantine action APPROVED, not EXECUTED — the agent hasn't run it yet", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAsAdmin(app);
    const { action } = await seedAlertWithAction("FILE_QUARANTINE");

    const res = await app.inject({
      method: "POST",
      url: `/response-actions/${action.id}/approve`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("APPROVED");
    expect(body.executedAt).toBeNull();
    expect(body.resultMessage).toBeNull();
  });
});

describe("GET /agent-commands", () => {
  it("returns an approved quarantine command for the owning agent, keyed by path from the alert", async () => {
    const agent = await prisma.agent.create({
      data: { key: `agent-${randomUUID()}`, hostname: "test-host", watchedRoot: "/tmp/test" },
    });
    const alert = await prisma.alert.create({
      data: {
        type: "SENSITIVE_DATA_EXPOSED",
        severity: "HIGH",
        message: "test",
        agentId: agent.id,
        metadata: { path: "/tmp/test/secret.txt" },
      },
    });
    await prisma.responseAction.create({
      data: { alertId: alert.id, type: "FILE_QUARANTINE", status: "APPROVED" },
    });
    // A PENDING one for a different alert should NOT show up yet.
    const otherAlert = await prisma.alert.create({
      data: { type: "SENSITIVE_DATA_EXPOSED", severity: "HIGH", message: "test", agentId: agent.id, metadata: { path: "/tmp/test/other.txt" } },
    });
    await prisma.responseAction.create({ data: { alertId: otherAlert.id, type: "FILE_QUARANTINE" } });

    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: `/agent-commands?agentKey=${agent.key}` });

    expect(res.statusCode).toBe(200);
    const commands = res.json();
    expect(commands).toEqual([{ id: expect.any(String), paths: ["/tmp/test/secret.txt"] }]);
  });

  it("normalizes a RANSOMWARE_RATE burst's metadata.affectedPaths into the same paths[] shape", async () => {
    const agent = await prisma.agent.create({
      data: { key: `agent-${randomUUID()}`, hostname: "test-host", watchedRoot: "/tmp/test" },
    });
    const alert = await prisma.alert.create({
      data: {
        type: "RANSOMWARE_RATE",
        severity: "CRITICAL",
        message: "test burst",
        agentId: agent.id,
        metadata: { affectedPaths: ["/tmp/test/a.txt", "/tmp/test/b.txt"] },
      },
    });
    await prisma.responseAction.create({
      data: { alertId: alert.id, type: "FILE_QUARANTINE", status: "APPROVED" },
    });

    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: `/agent-commands?agentKey=${agent.key}` });

    expect(res.json()).toEqual([{ id: expect.any(String), paths: ["/tmp/test/a.txt", "/tmp/test/b.txt"] }]);
  });

  it("404s for an unknown agent key", async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/agent-commands?agentKey=nonexistent-key" });
    expect(res.statusCode).toBe(404);
  });
});
