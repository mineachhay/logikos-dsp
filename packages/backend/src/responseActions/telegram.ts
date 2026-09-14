import type { AlertForNotification, NotificationResult } from "./webhook.js";

const SEVERITY_ICON: Record<string, string> = {
  CRITICAL: "🚨",
  HIGH: "🔴",
  MEDIUM: "🟠",
  LOW: "🟡",
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Pure, so the rendering is testable without a bot. HTML parse mode rather
 * than MarkdownV2: HTML needs three characters escaped, MarkdownV2 eighteen,
 * and alert messages and paths are full of `.`, `-` and `_`.
 */
export function formatTelegramAlert(alert: AlertForNotification): string {
  const icon = SEVERITY_ICON[alert.severity] ?? "⚠️";
  const lines = [
    `${icon} <b>${escapeHtml(alert.severity)} · ${escapeHtml(alert.type)}</b>`,
    escapeHtml(alert.message),
  ];
  if (alert.agent) {
    lines.push(`Agent: <code>${escapeHtml(alert.agent.hostname)}</code> — <code>${escapeHtml(alert.agent.watchedRoot)}</code>`);
  }
  lines.push(`Raised: ${alert.createdAt.toISOString()}`, `Alert ID: <code>${escapeHtml(alert.id)}</code>`);
  return lines.join("\n");
}

/**
 * Posts to the Bot API's sendMessage. Never throws, and never puts the bot
 * token in the result message: it's part of the request URL, and the result
 * is stored in ResponseAction.resultMessage and shown on the dashboard.
 */
export async function sendTelegramNotification(
  alert: AlertForNotification,
  botToken: string,
  chatId: string,
): Promise<NotificationResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatTelegramAlert(alert),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // The Bot API explains failures ("chat not found", "bot was blocked by the user").
      const body = (await res.json().catch(() => null)) as { description?: string } | null;
      return { ok: false, message: `telegram responded ${res.status}${body?.description ? `: ${body.description}` : ""}` };
    }
    return { ok: true, message: `telegram responded ${res.status}` };
  } catch (err) {
    return { ok: false, message: `telegram request failed: ${(err as Error).name === "TimeoutError" ? "timed out" : "network error"}` };
  }
}
