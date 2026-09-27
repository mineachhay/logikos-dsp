import nodemailer from "nodemailer";
import type { AlertForNotification, NotificationResult } from "./webhook.js";

export interface EmailSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  to: string[];
}

/** One alert as a short plain-text email. Port 465 is implicit TLS; others use STARTTLS when the server offers it. */
export async function sendEmailNotification(alert: AlertForNotification, cfg: EmailSettings, orgName: string): Promise<NotificationResult> {
  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    const prefix = orgName ? `[${orgName}] ` : "";
    const where = alert.agent ? `\nWhere: ${alert.agent.watchedRoot} (reported by ${alert.agent.hostname})` : "";
    await transport.sendMail({
      from: cfg.from,
      to: cfg.to,
      subject: `${prefix}${alert.severity} ${alert.type.replace(/_/g, " ").toLowerCase()}`,
      text: `${alert.message}${where}\nWhen: ${alert.createdAt.toISOString()}\nAlert ID: ${alert.id}\n`,
    });
    return { ok: true, message: `email sent to ${cfg.to.length} recipient(s)` };
  } catch (err) {
    return { ok: false, message: `email failed: ${(err as Error).message}` };
  }
}
