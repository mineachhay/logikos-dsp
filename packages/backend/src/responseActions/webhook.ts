import { sendTelegramNotification } from "./telegram.js";

export interface AlertForNotification {
  id: string;
  type: string;
  severity: string;
  message: string;
  createdAt: Date;
  agent: { hostname: string; watchedRoot: string } | null;
}

export interface NotificationResult {
  ok: boolean;
  message: string;
}

async function sendGenericWebhook(alert: AlertForNotification, url: string): Promise<NotificationResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alertId: alert.id,
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        agent: alert.agent,
        createdAt: alert.createdAt,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, message: `webhook responded ${res.status}` };
    }
    return { ok: true, message: `webhook responded ${res.status}` };
  } catch (err) {
    return { ok: false, message: `webhook request failed: ${(err as Error).message}` };
  }
}

/**
 * Executes a WEBHOOK_NOTIFICATION response action against every configured
 * channel: Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) and/or a generic
 * JSON webhook (RESPONSE_WEBHOOK_URL). The action type keeps its original name
 * rather than a migration to rename an enum value that already has rows.
 *
 * Succeeds only if every configured channel did, and records each channel's
 * outcome. Never throws — callers always get a result to store as
 * ResponseAction.resultMessage. Both requests are bounded to 10s because
 * approval waits on them.
 */
export async function sendWebhookNotification(alert: AlertForNotification): Promise<NotificationResult> {
  const sends: Promise<NotificationResult>[] = [];

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    sends.push(sendTelegramNotification(alert, botToken, chatId));
  } else if (botToken || chatId) {
    sends.push(Promise.resolve({ ok: false, message: "telegram needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" }));
  }

  const url = process.env.RESPONSE_WEBHOOK_URL;
  if (url) {
    sends.push(sendGenericWebhook(alert, url));
  }

  if (sends.length === 0) {
    return { ok: false, message: "no notification channel configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID or RESPONSE_WEBHOOK_URL)" };
  }

  const results = await Promise.all(sends);
  return { ok: results.every((r) => r.ok), message: results.map((r) => r.message).join("; ") };
}
