import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { recordAudit } from "../audit.js";
import { runRetention } from "../retention.js";

const days = (max: number) => z.number().int().min(1).max(max);

const settingsSchema = z.object({
  enabled: z.boolean(),
  fileEventDays: days(3650),
  fileActivityDays: days(3650),
  storageSnapshotDays: days(3650),
  resolvedAlertDays: days(3650),
  loginAttemptDays: days(365),
});

async function getSettings() {
  return prisma.retentionSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
}

/**
 * ADMIN-only. How long collected data is kept. Off until someone turns it on,
 * and the numbers are shown alongside how much is actually stored, so nobody
 * enables a 30-day policy without seeing that it deletes a year of history.
 */
export async function retentionRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.requireRole("ADMIN"));

  /** Settings plus what's actually stored, so a limit can be judged against reality. */
  async function view() {
    const [settings, fileEvents, fileActivity, storageSnapshots, resolvedAlerts, loginAttempts, oldestEvent] = await Promise.all([
      getSettings(),
      prisma.fileEvent.count(),
      prisma.fileActivity.count(),
      prisma.storageSnapshot.count(),
      prisma.alert.count({ where: { status: "RESOLVED" } }),
      prisma.loginAttempt.count(),
      prisma.fileEvent.findFirst({ orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    ]);
    return {
      ...settings,
      counts: { fileEvents, fileActivity, storageSnapshots, resolvedAlerts, loginAttempts },
      oldestFileEventAt: oldestEvent?.occurredAt ?? null,
    };
  }

  app.get("/retention", view);

  app.put("/retention", async (req) => {
    const body = settingsSchema.parse(req.body);
    await prisma.retentionSettings.update({ where: { id: "default" }, data: body });
    await recordAudit(req, "retention.update", { type: "retentionSettings", id: "default" }, body);
    return view();
  });

  /** Run the sweep now rather than waiting for the hourly pass. */
  app.post("/retention/run", async (req, reply) => {
    const result = await runRetention();
    if (!result) return reply.code(400).send({ error: "retention is off — turn it on first" });
    await recordAudit(req, "retention.run", { type: "retentionSettings", id: "default" }, { ...result });
    return result;
  });
}
