import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";
import { seedAuthedAgent } from "../auth/agentFixtures.testutil.js";
import { invalidateSettings, setting } from "../settings.js";

async function login(app: FastifyInstance, role: "ADMIN" | "VIEWER") {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  await prisma.user.create({ data: { email, passwordHash: await hashPassword("settings-test-pass-1"), role } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "settings-test-pass-1" } });
  const cookie = `token=${res.cookies.find((c) => c.name === "token")!.value}`;
  const call = (method: "GET" | "PUT" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: { cookie }, payload });
  return { email, call };
}

const valueOf = (res: { json(): { settings: { key: string; value: unknown; source: string; isSet?: boolean }[] } }, key: string) =>
  res.json().settings.find((s) => s.key === key)!;

afterEach(() => {
  delete process.env.AGENT_INSTALL_CA;
  invalidateSettings();
});

describe("settings API", () => {
  it("lets anyone signed in read the settings, and only admins change them", async () => {
    const app = await buildApp({ logger: false });
    const viewer = await login(app, "VIEWER");
    const res = await viewer.call("GET", "/settings");
    expect(res.statusCode).toBe(200);
    expect(res.json().sections.map((s: { id: string }) => s.id)).toContain("detection");
    expect(valueOf(res, "detection.ransomware.threshold")).toMatchObject({ value: 50, source: "default" });
    expect((await viewer.call("PUT", "/settings", { changes: { "detection.ransomware.threshold": 30 } })).statusCode).toBe(403);
  });

  it("refuses invalid values, and saves nothing when any change is invalid", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app, "ADMIN");
    const bad = await admin.call("PUT", "/settings", { changes: { "detection.bulkRead.threshold": 25, "detection.ransomware.threshold": 3 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/between 10/);
    expect(await prisma.setting.count()).toBe(0);
    expect((await admin.call("PUT", "/settings", { changes: { "no.such.setting": 1 } })).statusCode).toBe(400);
  });

  it("asks before a change that weakens protection", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app, "ADMIN");
    const ask = await admin.call("PUT", "/settings", { changes: { "security.lockAfterFailures": 20 } });
    expect(ask.statusCode).toBe(409);
    expect(ask.json().confirmations[0]).toMatch(/guessing/);
    const ok = await admin.call("PUT", "/settings", { changes: { "security.lockAfterFailures": 20 }, confirmed: true });
    expect(ok.statusCode).toBe(200);
    expect(await setting("security.lockAfterFailures")).toBe(20);
  });

  it("applies a detection threshold on the next event, and records who changed it", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app, "ADMIN");
    await admin.call("PUT", "/settings", { changes: { "detection.ransomware.threshold": 10 } });
    const { agent, headers } = await seedAuthedAgent();
    const events = Array.from({ length: 10 }, (_, i) => ({ agentKey: agent.key, eventType: "created", path: `f${i}.txt`, occurredAt: new Date().toISOString() }));
    await app.inject({ method: "POST", url: "/ingest/events", headers, payload: events });
    expect(await prisma.alert.count({ where: { type: "RANSOMWARE_RATE" } })).toBe(1); // the default of 50 wouldn't have fired
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetType: "setting", targetId: "detection.ransomware.threshold" } });
    expect(audit).toMatchObject({ userEmail: admin.email, action: "settings.update", details: { from: 50, to: 10 } });
  });

  it("resets to the default, and reverts a change from its history", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app, "ADMIN");
    await admin.call("PUT", "/settings", { changes: { "detection.bulkRead.threshold": 25 } });
    await admin.call("PUT", "/settings", { changes: { "detection.bulkRead.threshold": 40 } });
    const history = (await admin.call("GET", "/settings/history?key=detection.bulkRead.threshold")).json();
    expect(history.map((h: { details: { to: number } }) => h.details.to)).toEqual([40, 25]);
    await admin.call("POST", "/settings/revert", { auditId: history[0].id });
    expect(await setting("detection.bulkRead.threshold")).toBe(25);

    const reset = await admin.call("POST", "/settings/reset", { keys: ["detection.bulkRead.threshold"] });
    expect(valueOf(reset, "detection.bulkRead.threshold")).toMatchObject({ value: 50, source: "default" });
    expect(await prisma.setting.count()).toBe(0);
  });

  it("stores secrets encrypted, never returns them, and keeps them when saved as null", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app, "ADMIN");
    await admin.call("PUT", "/settings", { changes: { "notify.telegram.botToken": "123:secret-token" } });
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: "notify.telegram.botToken" } });
    expect(JSON.stringify(row.value)).not.toContain("secret-token");
    const read = await admin.call("GET", "/settings");
    expect(JSON.stringify(read.json())).not.toContain("secret-token");
    expect(valueOf(read, "notify.telegram.botToken")).toMatchObject({ isSet: true });
    await admin.call("PUT", "/settings", { changes: { "notify.telegram.botToken": null, "notify.telegram.chatId": "-100123" } });
    expect(await setting("notify.telegram.botToken")).toBe("123:secret-token");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: "notify.telegram.botToken" } });
    expect(JSON.stringify(audit.details)).not.toContain("secret-token");
  });

  it("shows a setting fixed by the server's environment as locked", async () => {
    process.env.AGENT_INSTALL_CA = "cloudflare-origin";
    const app = await buildApp({ logger: false });
    const admin = await login(app, "ADMIN");
    expect(valueOf(await admin.call("GET", "/settings"), "agents.installCa")).toMatchObject({ value: "cloudflare-origin", source: "env" });
    expect((await admin.call("PUT", "/settings", { changes: { "agents.installCa": "" } })).json().error).toMatch(/AGENT_INSTALL_CA/);
  });

  it("exports changes without secrets and imports them back", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app, "ADMIN");
    await admin.call("PUT", "/settings", { changes: { "general.timeZone": "Asia/Phnom_Penh", "notify.email.password": "p4ss" } });
    const exported = (await admin.call("GET", "/settings/export")).json();
    expect(exported.settings).toEqual({ "general.timeZone": "Asia/Phnom_Penh" });
    await admin.call("POST", "/settings/reset", { keys: ["general.timeZone"] });
    await admin.call("POST", "/settings/import", { settings: exported.settings });
    expect(await setting("general.timeZone")).toBe("Asia/Phnom_Penh");
  });

  it("tries a custom pattern on sample text, with the Luhn check when asked", async () => {
    const app = await buildApp({ logger: false });
    const admin = await login(app, "ADMIN");
    const res = await admin.call("POST", "/settings/test-pattern", { regex: "\\b\\d{16}\\b", validator: "luhn", text: "4111111111111111 and 4111111111111112" });
    expect(res.json()).toEqual({ matches: ["4111111111111111"] });
    expect((await admin.call("POST", "/settings/test-pattern", { regex: "(a+)+", text: "aaa" })).statusCode).toBe(400);
  });
});
