interface AlertForNotification {
  id: string;
  type: string;
  severity: string;
  message: string;
  createdAt: Date;
  agent: { hostname: string; watchedRoot: string } | null;
}

export interface WebhookResult {
  ok: boolean;
  message: string;
}

/**
 * Never throws — callers always get a result to record as ResponseAction.resultMessage,
 * whether the webhook isn't configured, unreachable, or returns a non-2xx status.
 */
export async function sendWebhookNotification(alert: AlertForNotification): Promise<WebhookResult> {
  const url = process.env.RESPONSE_WEBHOOK_URL;
  if (!url) {
    return { ok: false, message: "RESPONSE_WEBHOOK_URL not configured" };
  }

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
    });
    if (!res.ok) {
      return { ok: false, message: `webhook responded ${res.status}` };
    }
    return { ok: true, message: `webhook responded ${res.status}` };
  } catch (err) {
    return { ok: false, message: `webhook request failed: ${(err as Error).message}` };
  }
}
