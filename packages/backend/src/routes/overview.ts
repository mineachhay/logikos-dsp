import type { FastifyInstance } from "fastify";
import type { PatternPolicy, CustomPattern } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { setting } from "../settings.js";
import { TEMP_FILE_WHERE } from "./listQuery.js";

const ALERT_TREND_DAYS = 14;
const RECENT_ALERTS_LIMIT = 5;

/** YYYY-MM-DD in the configured time zone, so "today" on the chart is today where the reader is. */
function dayKey(d: Date, timeZone: string): string {
  try {
    return d.toLocaleDateString("sv-SE", { timeZone });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;

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
    const dayAgo = new Date(now.getTime() - dayMs);
    const timeZone = await setting<string>("general.timeZone");

    const [
      openBySeverity,
      totalAgents,
      activeAgents,
      matchesByPattern,
      trendAlerts,
      recentAlerts,
      latestSnapshotsPerAgent,
      eventsLast24h,
      tempEventsLast24h,
      pendingApprovals,
      activityByUser,
      bursts,
      discoverySources,
      examinedBySource,
      policies,
      customPatterns,
    ] = await Promise.all([
      prisma.alert.groupBy({ by: ["severity"], where: { status: "OPEN" }, _count: true }),
      prisma.agent.count(),
      prisma.agent.count({ where: { lastSeenAt: { gte: new Date(now.getTime() - dayMs) } } }),
      prisma.classificationMatch.groupBy({ by: ["patternType", "customName"], _count: true }),
      prisma.alert.findMany({
        where: { createdAt: { gte: trendStart } },
        select: { createdAt: true },
      }),
      prisma.alert.findMany({
        where: { status: "OPEN" },
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        take: RECENT_ALERTS_LIMIT,
        include: { agent: { select: { hostname: true } }, source: { select: { rootLabel: true } } },
      }),
      // Latest StorageSnapshot per source, summed — Prisma has no
      // "latest row per group" query, so this is two queries (which
      // source+timestamp pairs are latest, then fetch those specific
      // rows) rather than reaching for raw SQL in an otherwise
      // Prisma-only package.
      prisma.storageSnapshot
        .groupBy({ by: ["sourceId"], _max: { takenAt: true } })
        .then((latest) =>
          latest.length === 0
            ? []
            : prisma.storageSnapshot.findMany({
                where: { OR: latest.map((l) => ({ sourceId: l.sourceId, takenAt: l._max.takenAt! })) },
              }),
        ),
      // Office lock/save files are two thirds of raw events; counted apart, not in the headline.
      prisma.fileEvent.count({ where: { occurredAt: { gte: dayAgo }, NOT: TEMP_FILE_WHERE } }),
      prisma.fileEvent.count({ where: { occurredAt: { gte: dayAgo }, ...TEMP_FILE_WHERE } }),
      prisma.responseAction.count({ where: { status: "PENDING" } }),
      prisma.fileActivity.groupBy({ by: ["userDomain", "userName", "action"], where: { occurredAt: { gte: dayAgo } }, _count: true }),
      // The busiest minutes: what a mass change looks like before it reaches the alert threshold.
      prisma.$queryRaw<{ sourceId: string; minute: Date; count: bigint }[]>`
        SELECT "sourceId", date_trunc('minute', "occurredAt") AS minute, count(*) AS count FROM "FileEvent"
        WHERE "occurredAt" >= ${dayAgo} AND "path" !~ '(^|[/\\\\])~' AND "path" !~* '\\.tmp$'
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 3`,
      prisma.source.findMany({
        where: { discoveryCandidates: { not: null } },
        select: { id: true, rootLabel: true, fileServer: { select: { name: true } }, discoveryCandidates: true, discoveryPassFinishedAt: true },
      }),
      prisma.contentScan.groupBy({ by: ["sourceId"], _count: true }),
      setting<Record<string, PatternPolicy>>("classification.patterns"),
      setting<CustomPattern[]>("classification.customPatterns"),
    ]);

    const trendByDay = new Map<string, number>();
    for (let i = 0; i < ALERT_TREND_DAYS; i++) {
      trendByDay.set(dayKey(new Date(trendStart.getTime() + i * dayMs), timeZone), 0);
    }
    for (const a of trendAlerts) {
      const key = dayKey(a.createdAt, timeZone);
      trendByDay.set(key, (trendByDay.get(key) ?? 0) + 1);
    }

    const users = new Map<string, { user: string; changes: number; reads: number }>();
    for (const row of activityByUser) {
      const user = row.userDomain ? `${row.userDomain}\\${row.userName}` : row.userName;
      const entry = users.get(user.toLowerCase()) ?? { user, changes: 0, reads: 0 };
      if (row.action === "READ") entry.reads += row._count;
      else entry.changes += row._count;
      users.set(user.toLowerCase(), entry);
    }
    const burstSources = await prisma.source.findMany({
      where: { id: { in: bursts.map((b) => b.sourceId) } },
      select: { id: true, rootLabel: true, fileServer: { select: { name: true } } },
    });
    const examined = new Map(examinedBySource.map((e) => [e.sourceId, e._count]));
    const severityOf = (patternType: string, customName: string | null) =>
      patternType === "CUSTOM"
        ? (customPatterns.find((p) => p.name === customName)?.severity ?? "MEDIUM")
        : (policies[patternType]?.severity ?? "LOW");

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
      tempEventsLast24h,
      pendingApprovals,
      topUsers: [...users.values()].sort((a, b) => b.changes + b.reads - (a.changes + a.reads)).slice(0, 5),
      bursts: bursts.map((b) => ({ source: burstSources.find((s) => s.id === b.sourceId) ?? null, minute: b.minute, count: Number(b.count) })),
      discovery: discoverySources.map((s) => ({
        source: { id: s.id, rootLabel: s.rootLabel, fileServer: s.fileServer },
        examined: examined.get(s.id) ?? 0,
        candidates: s.discoveryCandidates ?? 0,
        passFinishedAt: s.discoveryPassFinishedAt,
      })),
      alertTrend: Array.from(trendByDay.entries()).map(([date, count]) => ({ date, count })),
      // Most serious first, then most frequent: 36 card numbers matter more than 3,000 email addresses.
      matchesByPattern: matchesByPattern
        .map((r) => ({ patternType: r.patternType, customName: r.customName, count: r._count, severity: severityOf(r.patternType, r.customName) }))
        .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count),
      recentAlerts,
    };
  });
}
