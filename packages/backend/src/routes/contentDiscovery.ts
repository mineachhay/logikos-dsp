import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { authenticateAgent } from "../auth/agentAuth.js";
import { resolveIngestSource } from "../sources.js";
import { removeContentScans } from "../contentScans.js";

/** Largest extracted-text sample accepted, base64 (the agent sends ~32 KB of text). */
const MAX_SAMPLE_B64 = 64 * 1024;

const scansSchema = z.object({
  agentKey: z.string().min(8),
  sourceId: z.string().uuid().optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        sizeBytes: z.number().int().nonnegative(),
        mtimeMs: z.number().int().nonnegative(),
        extractor: z.string().max(16),
        contentSample: z.string().max(MAX_SAMPLE_B64).optional(),
        note: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const progressSchema = z.object({
  agentKey: z.string().min(8),
  sourceId: z.string().uuid().optional(),
  candidates: z.number().int().nonnegative(),
  skippedType: z.number().int().nonnegative(),
  skippedSize: z.number().int().nonnegative(),
  passStartedAt: z.string().datetime().optional(),
  passFinishedAt: z.string().datetime().optional(),
});

/**
 * Content discovery: the agent examines files that already exist (not only
 * ones that change) and posts the extracted text here; the classification
 * worker takes it from there. See agent/src/contentDiscovery.ts.
 */
export async function contentDiscoveryRoutes(app: FastifyInstance) {
  // Agent-facing (per-agent secret), like /ingest/*.
  app.post("/ingest/content-scans", async (req, reply) => {
    const body = scansSchema.parse(req.body);
    const agent = await authenticateAgent(req, reply, body.agentKey);
    if (!agent) return reply;
    const source = await resolveIngestSource(agent, body.sourceId);
    if (!source) return reply.code(404).send({ error: "unknown source for this agent" });

    let queued = 0;
    for (const f of body.files) {
      const existing = await prisma.contentScan.findUnique({ where: { sourceId_path: { sourceId: source.id, path: f.path } } });
      // Unchanged since it was examined: nothing to do (a restarted agent re-sending).
      if (existing && existing.sizeBytes === BigInt(f.sizeBytes) && existing.mtimeMs === BigInt(f.mtimeMs)) continue;
      await prisma.$transaction(async (tx) => {
        if (existing) await removeContentScans(tx, { id: existing.id });
        const scan = await tx.contentScan.create({
          data: {
            sourceId: source.id,
            agentId: agent.id,
            path: f.path,
            sizeBytes: BigInt(f.sizeBytes),
            mtimeMs: BigInt(f.mtimeMs),
            extractor: f.extractor,
            contentSample: f.contentSample,
            note: f.note,
          },
        });
        if (f.contentSample) {
          await tx.classificationJob.create({ data: { contentScanId: scan.id } });
          queued++;
        }
      });
    }
    return reply.send({ queued });
  });

  app.post("/ingest/discovery-progress", async (req, reply) => {
    const body = progressSchema.parse(req.body);
    const agent = await authenticateAgent(req, reply, body.agentKey);
    if (!agent) return reply;
    const source = await resolveIngestSource(agent, body.sourceId);
    if (!source) return reply.code(404).send({ error: "unknown source for this agent" });
    await prisma.source.update({
      where: { id: source.id },
      data: {
        discoveryCandidates: body.candidates,
        discoverySkippedType: body.skippedType,
        discoverySkippedSize: body.skippedSize,
        ...(body.passStartedAt ? { discoveryPassStartedAt: new Date(body.passStartedAt), discoveryPassFinishedAt: null } : {}),
        ...(body.passFinishedAt ? { discoveryPassFinishedAt: new Date(body.passFinishedAt) } : {}),
      },
    });
    return reply.send({ ok: true });
  });

  /** What's already been examined, so a restarted agent resumes instead of starting over. */
  app.get<{ Params: { id: string }; Querystring: { agentKey?: string } }>("/agent-sync/sources/:id/content-scans", async (req, reply) => {
    const agent = await authenticateAgent(req, reply, req.query.agentKey ?? "");
    if (!agent) return reply;
    const source = await prisma.source.findUnique({ where: { id: req.params.id } });
    if (!source || source.agentId !== agent.id) return reply.code(404).send({ error: "source not found" });
    const rows = await prisma.contentScan.findMany({ where: { sourceId: source.id }, select: { path: true, sizeBytes: true, mtimeMs: true } });
    // Compact: [path, size, mtime] triples — tens of thousands of them.
    return rows.map((r) => [r.path, Number(r.sizeBytes), Number(r.mtimeMs)]);
  });

  // Dashboard-facing from here.
  /**
   * How much of each source discovery has actually examined — so "0 matches"
   * can't be mistaken for "no sensitive data" when the truth is "not looked at".
   */
  app.get("/content-discovery/coverage", { preHandler: app.authenticate }, async () => {
    const sources = await prisma.source.findMany({
      where: { OR: [{ discoveryCandidates: { not: null } }, { contentScans: { some: {} } }] },
      select: {
        id: true,
        rootLabel: true,
        fileServer: { select: { name: true } },
        agent: { select: { hostname: true } },
        discoveryCandidates: true,
        discoverySkippedType: true,
        discoverySkippedSize: true,
        discoveryPassStartedAt: true,
        discoveryPassFinishedAt: true,
        lastFileCount: true,
      },
    });
    return Promise.all(
      sources.map(async (s) => {
        const [examined, noText, pending, sensitive] = await Promise.all([
          prisma.contentScan.count({ where: { sourceId: s.id } }),
          prisma.contentScan.count({ where: { sourceId: s.id, contentSample: null } }),
          prisma.classificationJob.count({ where: { contentScan: { sourceId: s.id }, status: { in: ["PENDING", "PROCESSING"] } } }),
          prisma.contentScan.count({ where: { sourceId: s.id, job: { matches: { some: {} } } } }),
        ]);
        return {
          sourceId: s.id,
          name: s.fileServer ? `${s.fileServer.name} · ${s.rootLabel.replace(/^smb:\/\/[^/]+\//, "")}` : (s.agent?.hostname ?? s.rootLabel),
          rootLabel: s.rootLabel,
          totalFiles: s.lastFileCount,
          candidates: s.discoveryCandidates,
          skippedType: s.discoverySkippedType,
          skippedSize: s.discoverySkippedSize,
          examined,
          noText,
          pendingClassification: pending,
          filesWithSensitiveData: sensitive,
          passStartedAt: s.discoveryPassStartedAt,
          passFinishedAt: s.discoveryPassFinishedAt,
        };
      }),
    );
  });
}
