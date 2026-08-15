import {
  RANSOMWARE_RATE_THRESHOLD,
  RANSOMWARE_RATE_WINDOW_SECONDS,
  supportsQuarantine,
} from "@logikos-dsp/shared";
import { prisma } from "../db.js";

// A burst can touch far more files than anyone should approve-and-review in
// one click; capped so metadata stays bounded and the quarantine command
// list stays reviewable. Not a claim that files beyond this cap are safe —
// just that this rule doesn't try to be the tool that quarantines a
// 10,000-file burst unattended. See ARCHITECTURE.md.
const MAX_QUARANTINE_PATHS = 200;

/**
 * Naive rate-based ransomware/anomaly heuristic: if one agent reports more
 * than RANSOMWARE_RATE_THRESHOLD file events within RANSOMWARE_RATE_WINDOW_SECONDS,
 * raise (or refresh) a critical alert. This is intentionally simple — real
 * ransomware detection also weighs extension-rewrite patterns and entropy
 * changes, which belong in a follow-up rule, not a rewrite of this one.
 */
export async function checkRansomwareRate(agentId: string): Promise<void> {
  const windowStart = new Date(Date.now() - RANSOMWARE_RATE_WINDOW_SECONDS * 1000);

  const count = await prisma.fileEvent.count({
    where: { agentId, occurredAt: { gte: windowStart } },
  });

  if (count < RANSOMWARE_RATE_THRESHOLD) return;

  // Avoid spamming a new alert every single event once past threshold:
  // only create one if there isn't already an open ransomware-rate alert
  // for this agent from within the current window.
  const existing = await prisma.alert.findFirst({
    where: {
      agentId,
      type: "RANSOMWARE_RATE",
      status: "OPEN",
      createdAt: { gte: windowStart },
    },
  });
  if (existing) return;

  // Unlike a SENSITIVE_DATA_EXPOSED alert (exactly one file), a rate burst
  // has no single file to act on — but it does have a *set* of them: every
  // path this agent reported as created/modified within the window (not
  // deleted — nothing to quarantine there, the file's already gone).
  // Deduped since the same path can appear more than once in a burst
  // (edited repeatedly), capped so one alert can't demand reviewing an
  // unbounded list.
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  const recentEvents = await prisma.fileEvent.findMany({
    where: { agentId, occurredAt: { gte: windowStart }, eventType: { in: ["CREATED", "MODIFIED"] } },
    select: { path: true },
    orderBy: { occurredAt: "desc" },
  });
  const affectedPaths = [...new Set(recentEvents.map((e) => e.path))].slice(0, MAX_QUARANTINE_PATHS);

  const alert = await prisma.alert.create({
    data: {
      type: "RANSOMWARE_RATE",
      severity: "CRITICAL",
      agentId,
      message: `${count} file events from this agent in the last ${RANSOMWARE_RATE_WINDOW_SECONDS}s (threshold ${RANSOMWARE_RATE_THRESHOLD}) — possible ransomware or bulk-delete activity.`,
      metadata: { count, windowSeconds: RANSOMWARE_RATE_WINDOW_SECONDS, affectedPaths },
    },
  });

  // CRITICAL alerts get suggested response actions, but nothing fires until
  // an ADMIN approves it via POST /response-actions/:id/approve — see
  // ARCHITECTURE.md's "approve-first, always" note. Quarantine is only
  // suggested when there's actually something to quarantine on a
  // write-capable connector — same supportsQuarantine check the
  // classification worker uses for SENSITIVE_DATA_EXPOSED alerts.
  await prisma.responseAction.create({
    data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" },
  });
  if (affectedPaths.length > 0 && agent && supportsQuarantine(agent.watchedRoot)) {
    await prisma.responseAction.create({
      data: { alertId: alert.id, type: "FILE_QUARANTINE" },
    });
  }
}
