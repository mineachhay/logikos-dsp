import { buildApp } from "./app.js";
import { runRetention, summarize } from "./retention.js";

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
  } catch (err) {
    app.log.error({ err }, "retention sweep failed");
  }
}
setInterval(() => void sweep(), RETENTION_INTERVAL_MS).unref();
void sweep();
