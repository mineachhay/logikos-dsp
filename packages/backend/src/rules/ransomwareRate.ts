import {
  RANSOMWARE_RATE_THRESHOLD,
  RANSOMWARE_RATE_WINDOW_SECONDS,
} from "@logikos-dsp/shared";
import { prisma } from "../db.js";

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

  const alert = await prisma.alert.create({
    data: {
      type: "RANSOMWARE_RATE",
      severity: "CRITICAL",
      agentId,
      message: `${count} file events from this agent in the last ${RANSOMWARE_RATE_WINDOW_SECONDS}s (threshold ${RANSOMWARE_RATE_THRESHOLD}) — possible ransomware or bulk-delete activity.`,
      metadata: { count, windowSeconds: RANSOMWARE_RATE_WINDOW_SECONDS },
    },
  });

  // CRITICAL alerts get a suggested response action, but it only fires once
  // an ADMIN approves it via POST /response-actions/:id/approve — see
  // ARCHITECTURE.md's "approve-first, always" note.
  await prisma.responseAction.create({
    data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" },
  });
}
