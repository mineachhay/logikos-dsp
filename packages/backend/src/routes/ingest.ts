import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { checkRansomwareRate } from "../rules/ransomwareRate.js";

const fileEventTypeMap = {
  created: "CREATED",
  modified: "MODIFIED",
  deleted: "DELETED",
  renamed: "RENAMED",
  permission_changed: "PERMISSION_CHANGED",
} as const;

const fileEventSchema = z.object({
  agentKey: z.string().min(8),
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
  rootPath: z.string().min(1),
  totalBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  takenAt: z.string(),
});

async function resolveAgent(agentKey: string) {
  const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
  if (!agent) return null;
  await prisma.agent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
  return agent;
}

export async function ingestRoutes(app: FastifyInstance) {
  app.post("/ingest/events", async (req, reply) => {
    const events = eventsBatchSchema.parse(
      Array.isArray(req.body) ? req.body : [req.body],
    );

    // All events in a batch are expected to come from the same agent key,
    // but resolve defensively rather than assume.
    const agentCache = new Map<string, Awaited<ReturnType<typeof resolveAgent>>>();
    const touchedAgentIds = new Set<string>();
    let created = 0;
    let unknownAgentKeys = new Set<string>();

    for (const evt of events) {
      let agent = agentCache.get(evt.agentKey);
      if (agent === undefined) {
        agent = await resolveAgent(evt.agentKey);
        agentCache.set(evt.agentKey, agent);
      }
      if (!agent) {
        unknownAgentKeys.add(evt.agentKey);
        continue;
      }

      const fileEvent = await prisma.fileEvent.create({
        data: {
          agentId: agent.id,
          eventType: fileEventTypeMap[evt.eventType],
          path: evt.path,
          previousPath: evt.previousPath,
          sizeBytes: evt.sizeBytes,
          contentSample: evt.contentSample,
          occurredAt: new Date(evt.occurredAt),
        },
      });
      created++;
      touchedAgentIds.add(agent.id);

      if ((evt.eventType === "created" || evt.eventType === "modified") && evt.contentSample) {
        await prisma.classificationJob.create({
          data: { fileEventId: fileEvent.id, status: "PENDING" },
        });
      }
    }

    for (const agentId of touchedAgentIds) {
      await checkRansomwareRate(agentId);
    }

    if (unknownAgentKeys.size > 0 && created === 0) {
      return reply.code(404).send({ error: "unknown agentKey", agentKeys: [...unknownAgentKeys] });
    }

    return reply.send({ created, unknownAgentKeys: [...unknownAgentKeys] });
  });

  app.post("/ingest/storage", async (req, reply) => {
    const body = storageSnapshotSchema.parse(req.body);
    const agent = await resolveAgent(body.agentKey);
    if (!agent) {
      return reply.code(404).send({ error: "unknown agentKey" });
    }

    const snapshot = await prisma.storageSnapshot.create({
      data: {
        agentId: agent.id,
        rootPath: body.rootPath,
        totalBytes: BigInt(body.totalBytes),
        fileCount: body.fileCount,
        takenAt: new Date(body.takenAt),
      },
    });

    return reply.send({ id: snapshot.id });
  });
}
