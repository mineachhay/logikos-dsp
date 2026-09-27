import { buildApp } from "./app.js";
import { runRetention, summarize, thinSnapshots } from "./retention.js";
import { setting } from "./settings.js";
import { checkSilentAgents } from "./rules/agentSilence.js";
import { applyNotificationPolicy } from "./notificationPolicy.js";

const app = await buildApp();

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Retention sweep, here rather than in app.ts so tests driving buildApp() with
// app.inject() never start a timer that deletes their fixtures. Does nothing
// until an ADMIN turns retention on.
const RETENTION_INTERVAL_MS = Number(process.env.RETENTION_INTERVAL_MS ?? 3600_000);
async function sweep(): Promise<void> {
  try {
    const result = await runRetention();
    if (result) app.log.info(`retention: ${summarize(result)}`);
    if (await setting<boolean>("monitoring.snapshotThinning")) {
      const thinned = await thinSnapshots();
      if (thinned) app.log.info(`thinned ${thinned} old storage snapshot(s)`);
    }
  } catch (err) {
    app.log.error({ err }, "retention sweep failed");
  }
}
setInterval(() => void sweep(), RETENTION_INTERVAL_MS).unref();
void sweep();

// Share-scanning agents that stopped reporting (rules/agentSilence.ts). Same
// reason as retention for living here: tests must never start this timer.
async function checkAgents(): Promise<void> {
  try {
    const { raised, resolved } = await checkSilentAgents();
    if (raised || resolved) app.log.info(`agent silence: ${raised} raised, ${resolved} resolved`);
  } catch (err) {
    app.log.error({ err }, "agent silence check failed");
  }
}
setInterval(() => void checkAgents(), 60_000).unref();

// Settings → Notifications: offer notifications from the configured severity,
// and send the chosen alert types without approval (notificationPolicy.ts).
async function notificationPolicy(): Promise<void> {
  try {
    const { offered, sent } = await applyNotificationPolicy();
    if (offered || sent) app.log.info(`notifications: ${offered} offered, ${sent} sent automatically`);
  } catch (err) {
    app.log.error({ err }, "notification policy failed");
  }
}
setInterval(() => void notificationPolicy(), 15_000).unref();
