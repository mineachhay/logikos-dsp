import { sendTelegramNotification } from "./telegram.js";
import { sendEmailNotification } from "./email.js";
import { setting } from "../settings.js";

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
export type Channel = "telegram" | "webhook" | "email";

/**
 * Sends to every configured channel (Settings → Notifications; an environment
 * variable still wins, shown as locked there). Succeeds only if every channel
 * did. `only` limits it to one channel, for the Settings page's test button.
 */
export async function sendWebhookNotification(alert: AlertForNotification, only?: Channel): Promise<NotificationResult> {
  const sends: Promise<NotificationResult>[] = [];
  const want = (c: Channel) => !only || only === c;
  const orgName = await setting<string>("general.orgName");

  const botToken = await setting<string>("notify.telegram.botToken");
  const chatId = await setting<string>("notify.telegram.chatId");
  if (want("telegram")) {
    if (botToken && chatId) sends.push(sendTelegramNotification(orgName ? { ...alert, message: `[${orgName}] ${alert.message}` } : alert, botToken, chatId));
    else if (botToken || chatId || only === "telegram") sends.push(Promise.resolve({ ok: false, message: "telegram needs both a bot token and a chat ID" }));
  }

  const url = await setting<string>("notify.webhook.url");
  if (want("webhook")) {
    if (url) sends.push(sendGenericWebhook(alert, url));
    else if (only === "webhook") sends.push(Promise.resolve({ ok: false, message: "no webhook URL set" }));
  }

  const host = await setting<string>("notify.email.host");
  if (want("email")) {
    const to = await setting<string[]>("notify.email.to");
    const from = await setting<string>("notify.email.from");
    if (host && to.length && from) {
      sends.push(
        sendEmailNotification(
          alert,
          { host, port: await setting<number>("notify.email.port"), username: await setting<string>("notify.email.username"), password: await setting<string>("notify.email.password"), from, to },
          orgName,
        ),
      );
    } else if (host || only === "email") sends.push(Promise.resolve({ ok: false, message: "email needs an SMTP server, a from address and at least one recipient" }));
  }

  if (sends.length === 0) {
    return { ok: false, message: "no notification channel configured — set one under Settings → Notifications" };
  }
  const results = await Promise.all(sends);
  return { ok: results.every((r) => r.ok), message: results.map((r) => r.message).join("; ") };
}
