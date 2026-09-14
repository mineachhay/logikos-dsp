import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerAuth } from "./auth/plugin.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { agentRoutes } from "./routes/agents.js";
import { ingestRoutes } from "./routes/ingest.js";
import { agentCommandRoutes } from "./routes/agentCommands.js";
import { eventRoutes } from "./routes/events.js";
import { alertRoutes } from "./routes/alerts.js";
import { storageRoutes } from "./routes/storage.js";
import { classificationRoutes } from "./routes/classification.js";
import { responseActionRoutes } from "./routes/responseActions.js";
import { overviewRoutes } from "./routes/overview.js";

/**
 * Builds and returns the Fastify instance without binding a port, so tests
 * can drive it via app.inject() — the standard Fastify testing pattern —
 * using the exact same route/plugin registration code that runs in production.
 */
export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // trustProxy: this runs behind the shared nginx gateway (see deploy/dsp.conf),
  // which terminates TLS and sets X-Forwarded-For/-Proto. Without it Fastify
  // reports every request as coming from the proxy's own address, so the
  // request log — the only record of who approved a response action or created
  // a user — shows the Docker bridge IP for every client on the internet.
  // Safe here because the only route to this process is through that proxy;
  // if the backend is ever exposed directly, a client could forge the header.
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: true });

  await app.register(cors, { origin: true, credentials: true });
  await registerAuth(app);

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(authRoutes);
  await app.register(userRoutes);
  // Agent-facing: authenticated via Agent.key, not user login. Never gate these behind app.authenticate.
  await app.register(agentRoutes);
  await app.register(ingestRoutes);
  await app.register(agentCommandRoutes);
  // Dashboard-facing: each of these gates itself behind app.authenticate internally.
  await app.register(eventRoutes);
  await app.register(alertRoutes);
  await app.register(storageRoutes);
  await app.register(classificationRoutes);
  await app.register(responseActionRoutes);
  await app.register(overviewRoutes);

  return app;
}
