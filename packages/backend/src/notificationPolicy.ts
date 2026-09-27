import { SEVERITIES, inDailyWindow, type Severity } from "@logikos-dsp/shared";
import { prisma } from "./db.js";
import { setting } from "./settings.js";
import { executeNotification } from "./responseActions/execute.js";

/**
 * Settings → Notifications, applied to alerts from every source — the rules
 * here and the classification and backup workers, which are other processes
 * and just insert alerts. Run every few seconds from index.ts (never from
 * app.ts, so tests don't start a timer).
 *
 * 1. Alerts at or above "offer a notification from" get a pending
 *    notification if they don't have one (the creation sites attach one only
 *    to HIGH/CRITICAL).
 * 2. Pending notifications for alert types chosen to "send without approval"
 *    are sent — unless it's quiet hours, when they wait for an admin like any
 *    other. Approve-first stays the rule for everything else.
 */
const RECENT_MS = 24 * 3600_000;

export async function applyNotificationPolicy(now = new Date()): Promise<{ offered: number; sent: number }> {
  const since = new Date(now.getTime() - RECENT_MS);
  const from = await setting<Severity>("notify.suggestFromSeverity");
  const atOrAbove = SEVERITIES.slice(SEVERITIES.indexOf(from));

  const unoffered = await prisma.alert.findMany({
    where: { status: "OPEN", createdAt: { gte: since }, severity: { in: atOrAbove }, responseActions: { none: { type: "WEBHOOK_NOTIFICATION" } } },
    select: { id: true },
    take: 100,
  });
  for (const a of unoffered) await prisma.responseAction.create({ data: { alertId: a.id, type: "WEBHOOK_NOTIFICATION" } });

  const autoTypes = await setting<string[]>("notify.autoSend");
  let sent = 0;
  if (autoTypes.length) {
    const quiet = inDailyWindow(now, await setting<string>("notify.quietFrom"), await setting<string>("notify.quietUntil"), await setting<string>("general.timeZone"));
    const quietConfigured = (await setting<string>("notify.quietFrom")) !== (await setting<string>("notify.quietUntil"));
    if (!(quietConfigured && quiet)) {
      const due = await prisma.responseAction.findMany({
        where: { type: "WEBHOOK_NOTIFICATION", status: "PENDING", createdAt: { gte: since }, alert: { type: { in: autoTypes as never[] } } },
        select: { id: true },
        take: 20,
      });
      for (const a of due) {
        // Claim it first, so two loops (or an admin clicking) can't send it twice.
        const claimed = await prisma.responseAction.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "APPROVED", approvedAt: now } });
        if (claimed.count === 0) continue;
        await executeNotification(a.id, null, "sent automatically");
        sent++;
      }
    }
  }
  return { offered: unoffered.length, sent };
}
