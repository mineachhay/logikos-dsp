import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";

const ALERT_TREND_DAYS = 14;
const RECENT_ALERTS_LIMIT = 5;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, UTC — good enough for a trend bucket, not a timezone-aware report
}

/**
 * One aggregate endpoint for the dashboard's overview page, rather than
 * making the client pull full row sets from /alerts, /storage, etc. and
 * aggregate client-side — the counts here are meant to answer "is
 * anything wrong right now," which is cheap to compute once in Postgres
 * and wasteful to ship as hundreds of rows just to sum/bucket in the
 * browser.
 */
export async function overviewRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/overview", async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const trendStart = new Date(now.getTime() - (ALERT_TREND_DAYS - 1) * dayMs);

    const [
      openBySeverity,
      totalAgents,
      activeAgents,
      matchesByPattern,
      trendAlerts,
      recentAlerts,
      latestSnapshotsPerAgent,
      eventsLast24h,
    ] = await Promise.all([
      prisma.alert.groupBy({ by: ["severity"], where: { status: "OPEN" }, _count: true }),
      prisma.agent.count(),
      prisma.agent.count({ where: { lastSeenAt: { gte: new Date(now.getTime() - dayMs) } } }),
      prisma.classificationMatch.groupBy({ by: ["patternType"], _count: true }),
      prisma.alert.findMany({
        where: { createdAt: { gte: trendStart } },
        select: { createdAt: true },
      }),
      prisma.alert.findMany({
        where: { status: "OPEN" },
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        take: RECENT_ALERTS_LIMIT,
        include: { agent: { select: { hostname: true } } },
      }),
      // Latest StorageSnapshot per agent, summed — Prisma has no
      // "latest row per group" query, so this is two queries (which
      // agent+timestamp pairs are latest, then fetch those specific
      // rows) rather than reaching for raw SQL in an otherwise
      // Prisma-only package.
      prisma.storageSnapshot
        .groupBy({ by: ["agentId"], _max: { takenAt: true } })
        .then((latest) =>
          latest.length === 0
            ? []
            : prisma.storageSnapshot.findMany({
                where: { OR: latest.map((l) => ({ agentId: l.agentId, takenAt: l._max.takenAt! })) },
              }),
        ),
      prisma.fileEvent.count({ where: { occurredAt: { gte: new Date(now.getTime() - dayMs) } } }),
    ]);

    const trendByDay = new Map<string, number>();
    for (let i = 0; i < ALERT_TREND_DAYS; i++) {
      trendByDay.set(dayKey(new Date(trendStart.getTime() + i * dayMs)), 0);
    }
    for (const a of trendAlerts) {
      const key = dayKey(a.createdAt);
      trendByDay.set(key, (trendByDay.get(key) ?? 0) + 1);
    }

    const storageTotalBytes = latestSnapshotsPerAgent.reduce((sum, s) => sum + s.totalBytes, 0n);
    const storageFileCount = latestSnapshotsPerAgent.reduce((sum, s) => sum + s.fileCount, 0);

    return {
      alerts: {
        openBySeverity: Object.fromEntries(openBySeverity.map((r) => [r.severity, r._count])),
        openTotal: openBySeverity.reduce((sum, r) => sum + r._count, 0),
      },
      agents: { total: totalAgents, activeLast24h: activeAgents },
      storage: { totalBytes: storageTotalBytes.toString(), fileCount: storageFileCount },
      eventsLast24h,
      alertTrend: Array.from(trendByDay.entries()).map(([date, count]) => ({ date, count })),
      matchesByPattern: matchesByPattern.map((r) => ({ patternType: r.patternType, count: r._count })),
      recentAlerts,
    };
  });
}
