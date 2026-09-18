import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { checkRansomwareRate } from "../rules/ransomwareRate.js";
import { checkCopyToRemovable } from "../rules/copyToRemovable.js";
import { authenticateAgent } from "../auth/agentAuth.js";
import { resolveIngestSource } from "../sources.js";
import { backfillActorsForActivity, findActorForEvent, linkBetweenScanRenames, linkCopySources, linkCrossSourceCopies } from "../activity.js";
import { checkBulkRead } from "../rules/bulkRead.js";

const fileEventTypeMap = {
  created: "CREATED",
  modified: "MODIFIED",
  deleted: "DELETED",
  renamed: "RENAMED",
  copied: "COPIED",
  permission_changed: "PERMISSION_CHANGED",
} as const;

const fileEventSchema = z.object({
  agentKey: z.string().min(8),
  sourceId: z.string().uuid().optional(),
  eventType: z.enum(["created", "modified", "deleted", "renamed", "copied", "permission_changed"]),
  path: z.string().min(1),
  previousPath: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  occurredAt: z.string(),
  contentSample: z.string().optional(),
  removable: z.boolean().optional(),
  volumeLabel: z.string().max(200).optional(),
  volumeSerial: z.string().max(64).optional(),
});

const eventsBatchSchema = z.array(fileEventSchema).min(1).max(500);

const activitySchema = z.object({
  agentKey: z.string().min(8),
  fileServerId: z.string().uuid(),
  bookmark: z.number().int().nonnegative(),
  error: z.string().max(2000).optional(),
  records: z
    .array(
      z.object({
        sourceId: z.string().uuid().optional(),
        path: z.string().min(1).max(4096),
        action: z.enum(["CREATE", "WRITE", "DELETE", "RENAME", "READ", "OTHER"]),
        userName: z.string().min(1).max(256),
        userDomain: z.string().max(256).optional(),
        clientIp: z.string().max(64).optional(),
        occurredAt: z.string(),
        recordId: z.number().int().nonnegative(),
      }),
    )
    .max(1000)
    .default([]),
});

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
          removable: evt.removable ?? false,
          volumeLabel: evt.volumeLabel,
          volumeSerial: evt.volumeSerial,
          occurredAt: new Date(evt.occurredAt),
          // Windows audit record for this change, if the collector already has it
          // (activity.ts matches the other direction too, for records that arrive later).
          ...((await findActorForEvent(
            {
              sourceId: source.id,
              path: evt.path,
              previousPath: evt.previousPath,
              eventType: fileEventTypeMap[evt.eventType],
              occurredAt: new Date(evt.occurredAt),
            },
            source.scanIntervalSec,
          )) ?? {}),
        },
      });
      created++;

      if ((evt.eventType === "created" || evt.eventType === "modified") && evt.contentSample) {
        await prisma.classificationJob.create({
          data: { fileEventId: fileEvent.id, status: "PENDING" },
        });
      }
    }

    // A rename between two scans arrives as a create; the audit trail is what
    // identifies it (see linkBetweenScanRenames).
    await linkBetweenScanRenames(source.id);
    // Identical files in several folders look the same to a scan; the read
    // that a copy makes of its source is what names it.
    await linkCopySources(source.id);
    // A file arriving here that was just read somewhere else — a share copied
    // to a laptop, or between shares — is one copy, not two unrelated events.
    await linkCrossSourceCopies(source.id);
    // After the copy links are drawn, so the alert can say how much of what
    // went onto the stick came from a monitored share.
    await checkCopyToRemovable(source.id);
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

  /**
   * Windows Security events (5145) the agent collected over WinRM — who
   * changed what, from where. Stored as FileActivity and matched onto the
   * file events the scans reported; duplicates from a re-poll are ignored on
   * (fileServerId, recordId).
   */
  app.post("/ingest/activity", async (req, reply) => {
    const body = activitySchema.parse(req.body);
    const agent = await authenticateAgent(req, reply, body.agentKey);
    if (!agent) return reply;

    const server = await prisma.fileServer.findUnique({ where: { id: body.fileServerId }, include: { shares: true } });
    if (!server) return reply.code(404).send({ error: "unknown file server" });
    if (!server.shares.some((s) => s.agentId === agent.id)) {
      return reply.code(403).send({ error: "no share of this file server is assigned to this agent" });
    }

    const stored = [];
    for (const record of body.records) {
      // Only shares this agent holds, so one agent can't write activity for another's.
      if (record.sourceId && !server.shares.some((s) => s.id === record.sourceId && s.agentId === agent.id)) continue;
      try {
        stored.push(
          await prisma.fileActivity.create({
            data: {
              fileServerId: server.id,
              sourceId: record.sourceId,
              path: record.path,
              action: record.action,
              userName: record.userName,
              userDomain: record.userDomain,
              clientIp: record.clientIp,
              occurredAt: new Date(record.occurredAt),
              recordId: BigInt(record.recordId),
            },
          }),
        );
      } catch (err) {
        // P2002: already ingested this Windows record — a re-poll, not an error.
        if ((err as { code?: string }).code !== "P2002") throw err;
      }
    }

    const matched = await backfillActorsForActivity(stored);
    // A rename between two scans arrives as a create with no write of its own;
    // the delete record that just landed is what identifies it.
    for (const sourceId of new Set(stored.map((r) => r.sourceId).filter((id): id is string => Boolean(id)))) {
      await linkBetweenScanRenames(sourceId);
      await linkCopySources(sourceId);
    }
    // A read recorded here may explain a file that arrived anywhere else.
    for (const other of await prisma.source.findMany({ select: { id: true } })) {
      await linkCrossSourceCopies(other.id);
    }
    // Reads are only stored when the file server has read recording on; a burst
    // of them from one account is what copying a folder off the share looks like.
    const readers = new Map<string, { sourceId: string; userName: string }>();
    for (const record of stored) {
      if (record.action === "READ" && record.sourceId) {
        readers.set(`${record.sourceId}|${record.userName}`, { sourceId: record.sourceId, userName: record.userName });
      }
    }
    for (const { sourceId, userName } of readers.values()) {
      await checkBulkRead(sourceId, userName);
    }

    await prisma.fileServer.update({
      where: { id: server.id },
      data: {
        activityBookmark: BigInt(body.bookmark),
        lastActivityAt: new Date(),
        lastActivityError: body.error ?? null,
      },
    });
    return reply.send({ stored: stored.length, matched });
  });
}
