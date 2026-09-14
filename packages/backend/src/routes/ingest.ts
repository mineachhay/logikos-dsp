import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { checkRansomwareRate } from "../rules/ransomwareRate.js";
import { authenticateAgent } from "../auth/agentAuth.js";
import { resolveIngestSource } from "../sources.js";

const fileEventTypeMap = {
  created: "CREATED",
  modified: "MODIFIED",
  deleted: "DELETED",
  renamed: "RENAMED",
  permission_changed: "PERMISSION_CHANGED",
} as const;

const fileEventSchema = z.object({
  agentKey: z.string().min(8),
  sourceId: z.string().uuid().optional(),
  eventType: z.enum(["created", "modified", "deleted", "renamed", "permission_changed"]),
  path: z.string().min(1),
  previousPath: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  occurredAt: z.string(),
  contentSample: z.string().optional(),
});

const eventsBatchSchema = z.array(fileEventSchema).min(1).max(500);

const storageSnapshotSchema = z.object({
  agentKey: z.string().min(8),
  sourceId: z.string().uuid().optional(),
  rootPath: z.string().min(1),
  totalBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  takenAt: z.string(),
});

export async function ingestRoutes(app: FastifyInstance) {
  app.post("/ingest/events", async (req, reply) => {
    const events = eventsBatchSchema.parse(
      Array.isArray(req.body) ? req.body : [req.body],
    );

    // One credential authenticates one agent, so a batch may only carry that
    // agent's key. (Before agent auth this resolved keys per event; accepting
    // mixed keys now would let one agent's secret write as another.)
    const agentKeys = new Set(events.map((e) => e.agentKey));
    if (agentKeys.size !== 1) {
      return reply.code(400).send({ error: "all events in a batch must share one agentKey" });
    }
    // Likewise one source per batch: the agent posts each share's scan
    // separately, and the ransomware rule below is evaluated per source.
    if (new Set(events.map((e) => e.sourceId ?? "")).size !== 1) {
      return reply.code(400).send({ error: "all events in a batch must share one sourceId" });
    }
    const agent = await authenticateAgent(req, reply, events[0].agentKey);
    if (!agent) return reply;
    const source = await resolveIngestSource(agent, events[0].sourceId);
    if (!source) {
      return reply.code(404).send({ error: "unknown source for this agent" });
    }

    let created = 0;
    for (const evt of events) {
      const fileEvent = await prisma.fileEvent.create({
        data: {
          agentId: agent.id,
          sourceId: source.id,
          eventType: fileEventTypeMap[evt.eventType],
          path: evt.path,
          previousPath: evt.previousPath,
          sizeBytes: evt.sizeBytes,
          contentSample: evt.contentSample,
          occurredAt: new Date(evt.occurredAt),
        },
      });
      created++;

      if ((evt.eventType === "created" || evt.eventType === "modified") && evt.contentSample) {
        await prisma.classificationJob.create({
          data: { fileEventId: fileEvent.id, status: "PENDING" },
        });
      }
    }

    await checkRansomwareRate(source.id);

    return reply.send({ created });
  });

  app.post("/ingest/storage", async (req, reply) => {
    const body = storageSnapshotSchema.parse(req.body);
    const agent = await authenticateAgent(req, reply, body.agentKey);
    if (!agent) return reply;
    const source = await resolveIngestSource(agent, body.sourceId);
    if (!source) {
      return reply.code(404).send({ error: "unknown source for this agent" });
    }

    const snapshot = await prisma.storageSnapshot.create({
      data: {
        agentId: agent.id,
        sourceId: source.id,
        rootPath: body.rootPath,
        totalBytes: BigInt(body.totalBytes),
        fileCount: body.fileCount,
        takenAt: new Date(body.takenAt),
      },
    });

    return reply.send({ id: snapshot.id });
  });
}
