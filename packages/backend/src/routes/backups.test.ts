import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { decryptSecret } from "@logikos-dsp/shared/credentials";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/passwords.js";

const AGE_KEY = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

async function loginAs(app: FastifyInstance, role: "ADMIN" | "VIEWER"): Promise<string> {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const password = "correct-password-123";
  await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), role } });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === "token")!;
  return `${cookie.name}=${cookie.value}`;
}

async function setup() {
  const app = await buildApp({ logger: false });
  const cookie = await loginAs(app, "ADMIN");
  const as = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
  return { app, as };
}

function settings(overrides: object = {}) {
  return {
    enabled: false,
    scheduleTimeUtc: "03:15",
    verifyWeekday: 0,
    localRetention: 14,
    remoteRetention: 30,
    remotePath: "logikos-dsp",
    agePublicKey: AGE_KEY,
    destination: {
      type: "S3",
      config: { provider: "Cloudflare", endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "dsp-backups", accessKeyId: "AKIAEXAMPLE" },
      credentials: { secretAccessKey: "super-secret-s3-key" },
    },
    ...overrides,
  };
}

describe("backup settings", () => {
  it("is ADMIN-only", async () => {
    const app = await buildApp({ logger: false });
    const cookie = await loginAs(app, "VIEWER");
    expect((await app.inject({ method: "GET", url: "/backup/settings", headers: { cookie } })).statusCode).toBe(403);
  });

  it("stores destination secrets encrypted and reports only which are stored", async () => {
    const { as } = await setup();
    const res = await as("PUT", "/backup/settings", settings());
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("super-secret-s3-key");
    expect(res.json().storedCredentials).toEqual(["secretAccessKey"]);

    const got = (await as("GET", "/backup/settings")).json();
    expect(JSON.stringify(got)).not.toContain("super-secret-s3-key");
    expect(got.destination).toMatchObject({ type: "S3", config: { bucket: "dsp-backups" } });

    const row = await prisma.backupSettings.findUniqueOrThrow({ where: { id: "default" } });
    expect(row.credentialsEnc).not.toContain("super-secret");
    expect(JSON.parse(decryptSecret(row.credentialsEnc!))).toEqual({ secretAccessKey: "super-secret-s3-key" });
  });

  it("keeps stored secrets when a save leaves them blank, and drops them when the destination type changes", async () => {
    const { as } = await setup();
    await as("PUT", "/backup/settings", settings());
    const blank = settings();
    (blank.destination as { credentials: object }).credentials = { secretAccessKey: "" };
    expect((await as("PUT", "/backup/settings", blank)).statusCode).toBe(200);
    const row = await prisma.backupSettings.findUniqueOrThrow({ where: { id: "default" } });
    expect(JSON.parse(decryptSecret(row.credentialsEnc!))).toEqual({ secretAccessKey: "super-secret-s3-key" });

    const sftpWithoutCreds = settings({ destination: { type: "SFTP", config: { host: "backup.example.com", username: "dsp" } } });
    const res = await as("PUT", "/backup/settings", sftpWithoutCreds);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("password or a private key");
  });

  it("validates per destination type", async () => {
    const { as } = await setup();
    const noEndpoint = settings({
      destination: { type: "S3", config: { provider: "Backblaze", bucket: "b", accessKeyId: "k" }, credentials: { secretAccessKey: "s" } },
    });
    expect((await as("PUT", "/backup/settings", noEndpoint)).statusCode).toBe(400);

    const saWithoutSharedDrive = settings({
      destination: { type: "GDRIVE", config: { authMode: "SERVICE_ACCOUNT" }, credentials: { serviceAccountJson: "{}" } },
    });
    const res = await as("PUT", "/backup/settings", saWithoutSharedDrive);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("Shared drive");

    const oauth = settings({
      destination: { type: "GDRIVE", config: { authMode: "OAUTH_TOKEN", rootFolderId: "1AbC" }, credentials: { oauthTokenJson: '{"access_token":"x"}' } },
    });
    expect((await as("PUT", "/backup/settings", oauth)).statusCode).toBe(200);
  });

  it("refuses a private key where the age public key goes, and refuses to schedule without key and destination", async () => {
    const { as } = await setup();
    const leaked = await as("PUT", "/backup/settings", settings({ agePublicKey: "AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGP" }));
    expect(leaked.statusCode).toBe(400);
    expect(JSON.stringify(leaked.json())).toContain("never the AGE-SECRET-KEY");

    expect((await as("PUT", "/backup/settings", settings({ enabled: true, agePublicKey: null }))).statusCode).toBe(400);
    expect((await as("PUT", "/backup/settings", settings({ enabled: true, destination: null }))).statusCode).toBe(400);
  });

  it("starts the schedule from when it's turned on, not from a slot already past", async () => {
    const { as } = await setup();
    const before = new Date();
    const res = await as("PUT", "/backup/settings", settings({ enabled: true }));
    expect(res.json().nextBackupAt).not.toBeNull();
    const row = await prisma.backupSettings.findUniqueOrThrow({ where: { id: "default" } });
    expect(row.scheduleActiveSince!.getTime()).toBeGreaterThanOrEqual(before.getTime());

    // Saving again without changing the schedule keeps the original activation time.
    await as("PUT", "/backup/settings", settings({ enabled: true, remoteRetention: 60 }));
    const again = await prisma.backupSettings.findUniqueOrThrow({ where: { id: "default" } });
    expect(again.scheduleActiveSince).toEqual(row.scheduleActiveSince);
  });

  it("audits changes without secret values", async () => {
    const { as } = await setup();
    await as("PUT", "/backup/settings", settings());
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "backup.settings.update" } });
    expect(JSON.stringify(audit)).not.toContain("super-secret-s3-key");
    expect(audit.details).toMatchObject({ destinationType: "S3", credentialsReplaced: ["secretAccessKey"] });
  });
});

describe("backup runs", () => {
  it("won't queue a backup before a destination and key exist, or twice at once", async () => {
    const { as } = await setup();
    expect((await as("POST", "/backup/runs", { kind: "BACKUP" })).statusCode).toBe(400);

    await as("PUT", "/backup/settings", settings());
    const first = await as("POST", "/backup/runs", { kind: "BACKUP" });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ kind: "BACKUP", trigger: "MANUAL", status: "PENDING" });
    expect((await as("POST", "/backup/runs", { kind: "BACKUP" })).statusCode).toBe(409);
    expect((await as("POST", "/backup/runs", { kind: "TEST_DESTINATION" })).statusCode).toBe(202);

    const runs = (await as("GET", "/backup/runs")).json();
    expect(runs.map((r: { kind: string }) => r.kind).sort()).toEqual(["BACKUP", "TEST_DESTINATION"]);
  });

  it("reports the worker offline until it heartbeats", async () => {
    const { as } = await setup();
    expect((await as("GET", "/backup/settings")).json().worker.online).toBe(false);
    await prisma.backupSettings.update({ where: { id: "default" }, data: { workerHeartbeatAt: new Date() } });
    expect((await as("GET", "/backup/settings")).json().worker.online).toBe(true);
  });
});
