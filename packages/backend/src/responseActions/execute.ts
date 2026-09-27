import { prisma } from "../db.js";
import { sendWebhookNotification } from "./webhook.js";

/**
 * Sends a pending WEBHOOK_NOTIFICATION and records the outcome. The one path
 * for both an admin's Approve and an automatic send (notificationPolicy.ts),
 * so they can't drift apart. `approvedByUserId` is null for automatic sends.
 */
export async function executeNotification(actionId: string, approvedByUserId: string | null, note?: string) {
  const action = await prisma.responseAction.findUniqueOrThrow({
    where: { id: actionId },
    include: { alert: { include: { agent: { select: { hostname: true, watchedRoot: true } }, source: { select: { rootLabel: true } } } } },
  });
  // Name the share the alert is about, not the agent's own watch root — one agent can scan many shares.
  const { alert } = action;
  const result = await sendWebhookNotification({
    ...alert,
    agent: alert.agent ? { hostname: alert.agent.hostname, watchedRoot: alert.source?.rootLabel ?? alert.agent.watchedRoot } : null,
  });
  return prisma.responseAction.update({
    where: { id: action.id },
    data: {
      status: result.ok ? "EXECUTED" : "FAILED",
      approvedByUserId,
      approvedAt: new Date(),
      executedAt: new Date(),
      resultMessage: note ? `${note}: ${result.message}` : result.message,
    },
  });
}
