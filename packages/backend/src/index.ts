import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerAuth } from "./auth/plugin.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { agentRoutes } from "./routes/agents.js";
import { ingestRoutes } from "./routes/ingest.js";
import { eventRoutes } from "./routes/events.js";
import { alertRoutes } from "./routes/alerts.js";
import { storageRoutes } from "./routes/storage.js";
import { classificationRoutes } from "./routes/classification.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: true });
await registerAuth(app);

app.get("/health", async () => ({ status: "ok" }));

await app.register(authRoutes);
await app.register(userRoutes);
// Agent-facing: authenticated via Agent.key, not user login. Never gate these behind app.authenticate.
await app.register(agentRoutes);
await app.register(ingestRoutes);
// Dashboard-facing: each of these gates itself behind app.authenticate internally.
await app.register(eventRoutes);
await app.register(alertRoutes);
await app.register(storageRoutes);
await app.register(classificationRoutes);

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
