import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SETTINGS, SETTINGS_BY_KEY, SETTING_SECTIONS, regexProblem } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { recordAudit } from "../audit.js";
import { applySettingChanges, describeSettings, type ChangeResult } from "../settings.js";
import { sendWebhookNotification } from "../responseActions/webhook.js";

const changeSchema = z.object({ changes: z.record(z.unknown()), confirmed: z.boolean().default(false) });
const resetSchema = z.object({ keys: z.array(z.string()).min(1).max(SETTINGS.length) });
const revertSchema = z.object({ auditId: z.string().uuid(), confirmed: z.boolean().default(false) });
const importSchema = z.object({ settings: z.record(z.unknown()), confirmed: z.boolean().default(false) });
const testPatternSchema = z.object({ regex: z.string().max(300), validator: z.enum(["none", "luhn"]).default("none"), text: z.string().max(20_000) });

async function respond(req: FastifyRequest, reply: FastifyReply, result: ChangeResult, action = "settings.update") {
  if (!result.ok) return reply.code(result.status).send({ error: result.error, confirmations: result.confirmations });
  for (const c of result.changed) await recordAudit(req, action, { type: "setting", id: c.key }, { from: c.from, to: c.to } as never);
  return reply.send({ changed: result.changed.map((c) => c.key), settings: await describeSettings() });
}

/** Luhn check for the "luhn" validator on custom patterns (card-like numbers). */
export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * The Settings page's API. Reading is open to every signed-in user (a viewer
 * sees how the system is configured); changing is ADMIN-only and every change
 * is audited with its before and after values — secrets only as "(set)".
 */
export async function settingsRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);
  const admin = { preHandler: app.requireRole("ADMIN") };

  app.get("/settings", async () => ({ sections: SETTING_SECTIONS, settings: await describeSettings() }));

  app.put("/settings", admin, async (req, reply) => {
    const body = changeSchema.parse(req.body);
    return respond(req, reply, await applySettingChanges(body.changes, req.user.email, body.confirmed));
  });

  app.post("/settings/reset", admin, async (req, reply) => {
    const { keys } = resetSchema.parse(req.body);
    const changes = Object.fromEntries(keys.map((k) => [k, undefined]));
    return respond(req, reply, await applySettingChanges(changes, req.user.email, true), "settings.reset");
  });

  app.get("/settings/history", async (req) => {
    const { key, limit } = z.object({ key: z.string().optional(), limit: z.coerce.number().int().positive().max(200).default(50) }).parse(req.query);
    return prisma.auditLog.findMany({ where: { targetType: "setting", ...(key ? { targetId: key } : {}) }, orderBy: { createdAt: "desc" }, take: limit });
  });

  /** Put a setting back to what it was before a recorded change. */
  app.post("/settings/revert", admin, async (req, reply) => {
    const body = revertSchema.parse(req.body);
    const entry = await prisma.auditLog.findUnique({ where: { id: body.auditId } });
    if (!entry || entry.targetType !== "setting" || !entry.targetId) return reply.code(404).send({ error: "no such settings change" });
    const def = SETTINGS_BY_KEY.get(entry.targetId);
    if (!def || def.type === "secret") return reply.code(400).send({ error: "secrets can't be reverted — enter the value again" });
    const from = (entry.details as { from?: unknown } | null)?.from;
    return respond(req, reply, await applySettingChanges({ [def.key]: from }, req.user.email, body.confirmed), "settings.revert");
  });

  /** Everything changed from its default, as JSON — to copy to another install or keep. Never secrets. */
  app.get("/settings/export", admin, async (_req, reply) => {
    const all = await describeSettings();
    const settings = Object.fromEntries(all.filter((s) => s.source === "saved" && s.type !== "secret").map((s) => [s.key, s.value]));
    return reply
      .header("content-disposition", `attachment; filename="logikos-dsp-settings.json"`)
      .send({ format: 1, exportedAt: new Date().toISOString(), settings });
  });

  app.post("/settings/import", admin, async (req, reply) => {
    const body = importSchema.parse(req.body);
    const changes = Object.fromEntries(Object.entries(body.settings).filter(([k]) => SETTINGS_BY_KEY.get(k)?.type !== "secret"));
    return respond(req, reply, await applySettingChanges(changes, req.user.email, body.confirmed), "settings.import");
  });

  /** Sends a clearly-labelled test message through one channel, with the saved settings. */
  app.post("/settings/notifications/test", admin, async (req) => {
    const { channel } = z.object({ channel: z.enum(["telegram", "webhook", "email"]) }).parse(req.body);
    const result = await sendWebhookNotification(
      {
        id: "test",
        type: "TEST",
        severity: "LOW",
        message: `Test notification from logikos-dsp, sent by ${req.user.email} from Settings. No action needed.`,
        createdAt: new Date(),
        agent: null,
      },
      channel,
    );
    await recordAudit(req, "settings.notifications.test", { type: "setting", id: `notify.${channel}` }, { ok: result.ok, message: result.message });
    return result;
  });

  /** Try a custom pattern on sample text before enabling it. */
  app.post("/settings/test-pattern", admin, async (req, reply) => {
    const body = testPatternSchema.parse(req.body);
    const problem = regexProblem(body.regex);
    if (problem) return reply.code(400).send({ error: problem });
    const re = new RegExp(body.regex, "g");
    const matches: string[] = [];
    for (const m of body.text.matchAll(re)) {
      if (m[0] && (body.validator === "none" || luhnValid(m[0]))) matches.push(m[0]);
      if (matches.length >= 50) break;
    }
    return { matches };
  });
}
