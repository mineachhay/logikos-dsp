import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const querySchema = z.object({
  agentId: z.string().optional(),
  sourceId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export async function storageRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/storage", async (req) => {
    const { agentId, sourceId, limit } = querySchema.parse(req.query);

    const rows = await prisma.storageSnapshot.findMany({
      where: { agentId, sourceId },
      orderBy: { takenAt: "desc" },
      take: limit,
      include: { agent: { select: { hostname: true, watchedRoot: true } }, source: { select: { id: true, kind: true, rootLabel: true, fileServer: { select: { name: true } } } } },
    });

    // BigInt doesn't serialize through JSON.stringify by default.
    return rows.map((r) => ({ ...r, totalBytes: r.totalBytes.toString() }));
  });

  /**
   * What the Storage page shows: per source, the latest size, the size a week
   * ago, whether it has ever held a file, and its size per day for 30 days
   * (the day's last snapshot). Scans run every minute or so, so the raw
   * snapshot list — what the page used to show — was a minute-by-minute log
   * dominated by whichever source scanned most, not an answer to "how big is
   * it and is it growing".
   */
  app.get("/storage/summary", async () => {
    const [latest, weekAgo, daily, ever, sources] = await Promise.all([
      prisma.$queryRaw<{ sourceId: string; totalBytes: bigint; fileCount: number; takenAt: Date }[]>`
        SELECT DISTINCT ON ("sourceId") "sourceId", "totalBytes", "fileCount", "takenAt"
        FROM "StorageSnapshot" WHERE "sourceId" IS NOT NULL ORDER BY "sourceId", "takenAt" DESC`,
      prisma.$queryRaw<{ sourceId: string; totalBytes: bigint; fileCount: number }[]>`
        SELECT DISTINCT ON ("sourceId") "sourceId", "totalBytes", "fileCount"
        FROM "StorageSnapshot" WHERE "sourceId" IS NOT NULL AND "takenAt" <= now() - interval '7 days'
        ORDER BY "sourceId", "takenAt" DESC`,
      prisma.$queryRaw<{ sourceId: string; day: Date; totalBytes: bigint; fileCount: number }[]>`
        SELECT "sourceId", date_trunc('day', "takenAt") AS day,
               (array_agg("totalBytes" ORDER BY "takenAt" DESC))[1] AS "totalBytes",
               (array_agg("fileCount" ORDER BY "takenAt" DESC))[1] AS "fileCount"
        FROM "StorageSnapshot" WHERE "sourceId" IS NOT NULL AND "takenAt" > now() - interval '30 days'
        GROUP BY 1, 2 ORDER BY 2`,
      prisma.$queryRaw<{ sourceId: string; maxFiles: number }[]>`
        SELECT "sourceId", max("fileCount") AS "maxFiles" FROM "StorageSnapshot" WHERE "sourceId" IS NOT NULL GROUP BY 1`,
      prisma.source.findMany({ select: { id: true, rootLabel: true, fileServer: { select: { name: true } }, agent: { select: { hostname: true } } } }),
    ]);
    const byId = new Map(sources.map((s) => [s.id, s]));
    return latest.map((l) => {
      const src = byId.get(l.sourceId);
      const before = weekAgo.find((w) => w.sourceId === l.sourceId);
      return {
        sourceId: l.sourceId,
        rootLabel: src?.rootLabel ?? "",
        name: src?.fileServer ? `${src.fileServer.name} · ${src.rootLabel.replace(/^smb:\/\/[^/]+\//, "")}` : (src?.agent?.hostname ?? "—"),
        totalBytes: l.totalBytes.toString(),
        fileCount: l.fileCount,
        takenAt: l.takenAt,
        weekAgo: before ? { totalBytes: before.totalBytes.toString(), fileCount: before.fileCount } : null,
        everHadFiles: (ever.find((e) => e.sourceId === l.sourceId)?.maxFiles ?? 0) > 0,
        history: daily
          .filter((d) => d.sourceId === l.sourceId)
          .map((d) => ({ date: d.day.toISOString().slice(0, 10), totalBytes: d.totalBytes.toString(), fileCount: d.fileCount })),
      };
    });
  });
}
