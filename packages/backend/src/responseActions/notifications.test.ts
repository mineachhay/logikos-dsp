import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTelegramAlert } from "./telegram.js";
import { sendWebhookNotification, type AlertForNotification } from "./webhook.js";

const alert: AlertForNotification = {
  id: "a1",
  type: "SENSITIVE_DATA_EXPOSED",
  severity: "HIGH",
  message: "3 matches in <payroll> & taxes.csv",
  createdAt: new Date("2026-09-14T10:00:00Z"),
  agent: { hostname: "files01", watchedRoot: "/srv/share" },
};

const envKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "RESPONSE_WEBHOOK_URL"] as const;
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof envKeys)[number], string>>) {
  for (const k of envKeys) delete process.env[k];
  Object.assign(process.env, values);
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("formatTelegramAlert", () => {
  it("escapes HTML in alert text so Telegram doesn't reject the message", () => {
    const text = formatTelegramAlert(alert);
    expect(text).toContain("3 matches in &lt;payroll&gt; &amp; taxes.csv");
    expect(text).toContain("<b>HIGH · SENSITIVE_DATA_EXPOSED</b>");
    expect(text).toContain("<code>files01</code>");
  });

  it("omits the agent line for an alert without an agent", () => {
    expect(formatTelegramAlert({ ...alert, agent: null })).not.toContain("Agent:");
  });
});

describe("sendWebhookNotification", () => {
  it("fails clearly when nothing is configured", async () => {
    setEnv({});
    const result = await sendWebhookNotification(alert);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no notification channel configured");
  });

  it("sends to Telegram with the chat id and HTML parse mode", async () => {
    setEnv({ TELEGRAM_BOT_TOKEN: "123:secret-token", TELEGRAM_CHAT_ID: "-10042" });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendWebhookNotification(alert);

    expect(result).toEqual({ ok: true, message: "telegram responded 200" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:secret-token/sendMessage");
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: "-10042", parse_mode: "HTML" });
  });

  it("reports Telegram's error description but never the bot token", async () => {
    setEnv({ TELEGRAM_BOT_TOKEN: "123:secret-token", TELEGRAM_CHAT_ID: "1" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })),
    );
    const result = await sendWebhookNotification(alert);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("telegram responded 400: Bad Request: chat not found");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect to https://api.telegram.org/bot123:secret-token failed")));
    const failed = await sendWebhookNotification(alert);
    expect(failed.message).not.toContain("secret-token");
  });

  it("flags a half-configured Telegram instead of silently skipping it", async () => {
    setEnv({ TELEGRAM_BOT_TOKEN: "123:secret-token" });
    const result = await sendWebhookNotification(alert);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("TELEGRAM_CHAT_ID");
  });

  it("sends to every configured channel and fails if any one does", async () => {
    setEnv({ TELEGRAM_BOT_TOKEN: "123:t", TELEGRAM_CHAT_ID: "1", RESPONSE_WEBHOOK_URL: "http://hook.test/x" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => Promise.resolve(new Response("{}", { status: url.startsWith("https://api.telegram.org") ? 200 : 502 }))),
    );
    const result = await sendWebhookNotification(alert);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("telegram responded 200; webhook responded 502");
  });
});
