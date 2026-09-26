import { X509Certificate } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { encryptSecret } from "@logikos-dsp/shared/credentials";
import { prisma } from "../db.js";
import { recordAudit } from "../audit.js";
import { baseDnForDomain } from "../auth/directory.js";
import { loadDirectoryConfig, testDirectory } from "../auth/directoryClient.js";

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/, "a host name or IP address, without ldaps:// or a port");

const settingsSchema = z.object({
  enabled: z.boolean(),
  domain: z.string().trim().max(253).regex(/^[a-zA-Z0-9.-]*$/, "a DNS domain name like corp.example"),
  servers: z.array(hostSchema).max(10),
  port: z.number().int().min(1).max(65535).default(636),
  baseDn: z.string().trim().max(1024).default(""),
  bindUsername: z.string().trim().max(512),
  /** Omit to keep the stored one. */
  bindPassword: z.string().max(1024).optional(),
  caCertPem: z.string().max(20_000).default(""),
  adminGroup: z.string().trim().max(1024),
  viewerGroup: z.string().trim().max(1024).default(""),
});

const testSchema = z.object({
  username: z.string().trim().max(256).optional(),
  password: z.string().max(1024).optional(),
});

async function currentSettings() {
  return prisma.directorySettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
}

function publicSettings(s: Awaited<ReturnType<typeof currentSettings>>) {
  const { bindPasswordEnc, ...rest } = s;
  return { ...rest, hasBindPassword: Boolean(bindPasswordEnc), effectiveBaseDn: s.baseDn || baseDnForDomain(s.domain) };
}

/** Admin-only settings for signing in with Active Directory accounts (auth/directoryClient.ts). */
export async function directoryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.requireRole("ADMIN"));

  app.get("/directory/settings", async () => publicSettings(await currentSettings()));

  app.put("/directory/settings", async (req, reply) => {
    const body = settingsSchema.parse(req.body);
    const existing = await currentSettings();
    const caCertPem = body.caCertPem.trim();
    if (caCertPem) {
      try {
        new X509Certificate(caCertPem);
      } catch {
        return reply.code(400).send({ error: "the CA certificate isn't a PEM certificate (-----BEGIN CERTIFICATE-----)" });
      }
    }
    const willHavePassword = Boolean(body.bindPassword) || Boolean(existing.bindPasswordEnc);
    if (body.enabled) {
      const missing = [
        !body.domain && "domain",
        body.servers.length === 0 && "at least one domain controller",
        !body.bindUsername && "lookup account",
        !willHavePassword && "lookup account password",
        !body.adminGroup && "admin group",
      ].filter(Boolean);
      if (missing.length) return reply.code(400).send({ error: `to turn it on, fill in: ${missing.join(", ")}` });
    }
    const saved = await prisma.directorySettings.update({
      where: { id: "default" },
      data: {
        enabled: body.enabled,
        domain: body.domain.toLowerCase(),
        servers: body.servers,
        port: body.port,
        baseDn: body.baseDn,
        bindUsername: body.bindUsername,
        ...(body.bindPassword ? { bindPasswordEnc: encryptSecret(body.bindPassword) } : {}),
        caCertPem,
        adminGroup: body.adminGroup,
        viewerGroup: body.viewerGroup,
      },
    });
    await recordAudit(req, "directory.update", { type: "directory" }, {
      enabled: saved.enabled,
      domain: saved.domain,
      servers: saved.servers,
      adminGroup: saved.adminGroup,
      viewerGroup: saved.viewerGroup,
      ...(body.bindPassword ? { passwordReplaced: true } : {}),
    });
    return publicSettings(saved);
  });

  /**
   * Runs the saved settings end to end — even while sign-in is still off, so
   * it can be proven before anyone depends on it. With a username and
   * password it also tries that sign-in (the password isn't stored or logged).
   */
  app.post("/directory/test", async (req, reply) => {
    const body = testSchema.parse(req.body ?? {});
    const cfg = await loadDirectoryConfig({ evenIfDisabled: true });
    if (!cfg) return reply.code(400).send({ error: "save the domain controllers, lookup account and its password first" });
    const login = body.username && body.password ? { name: body.username, password: body.password } : undefined;
    return { steps: await testDirectory(cfg, login) };
  });
}
