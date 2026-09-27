import { connect } from "node:tls";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { setting } from "../settings.js";

interface CertInfo {
  name: string;
  host: string;
  port: number;
  expiresAt: string | null;
  subject: string | null;
  error: string | null;
}

/**
 * Reads a server's TLS certificate — only to know when it expires. Not
 * verified here on purpose: this checks dates, it doesn't trust anything; the
 * connections that matter (LDAPS, agents) verify properly on their own.
 */
function peerCertificate(name: string, host: string, port: number): Promise<CertInfo> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: /^[\d.]+$/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: 5000 });
    const done = (info: Partial<CertInfo>) => {
      socket.destroy();
      resolve({ name, host, port, expiresAt: null, subject: null, error: null, ...info });
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert?.valid_to) return done({ error: "no certificate offered" });
      const cn = cert.subject?.CN;
      done({ expiresAt: new Date(cert.valid_to).toISOString(), subject: (Array.isArray(cn) ? cn[0] : cn) ?? null });
    });
    socket.once("timeout", () => done({ error: "timed out" }));
    socket.once("error", (err) => done({ error: err.message }));
  });
}

let certCache: { at: number; certs: CertInfo[] } | null = null;

async function certificates(): Promise<CertInfo[]> {
  if (certCache && Date.now() - certCache.at < 3600_000) return certCache.certs;
  const targets: { name: string; host: string; port: number }[] = [];
  const publicUrl = process.env.PUBLIC_BACKEND_URL;
  if (publicUrl?.startsWith("https://")) {
    const u = new URL(publicUrl);
    targets.push({ name: "Dashboard website", host: u.hostname, port: Number(u.port || 443) });
  }
  const dir = await prisma.directorySettings.findUnique({ where: { id: "default" } });
  if (dir?.enabled) for (const server of dir.servers) targets.push({ name: `AD domain controller (LDAPS)`, host: server, port: dir.port });
  const certs = await Promise.all(targets.map((t) => peerCertificate(t.name, t.host, t.port)));
  certCache = { at: Date.now(), certs };
  return certs;
}

const DAY = 86_400_000;

/**
 * System health for Settings → System: what's running, how full things are,
 * and what's about to break — certificates first, since two were weeks from
 * expiring on the first real install with nothing to say so.
 */
export async function systemRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.get("/system/health", { preHandler: app.requireRole("ADMIN") }, async () => {
    const now = Date.now();
    const [dbSize, backup, lastBackup, pending, lastJob, agents, certs] = await Promise.all([
      prisma.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`,
      prisma.backupSettings.findUnique({ where: { id: "default" } }),
      prisma.backupRun.findFirst({ where: { kind: "BACKUP", status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } }),
      prisma.classificationJob.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
      prisma.classificationJob.findFirst({ where: { processedAt: { not: null } }, orderBy: { processedAt: "desc" }, select: { processedAt: true } }),
      prisma.agent.findMany({ where: { revokedAt: null }, select: { hostname: true, lastSeenAt: true, version: true } }),
      certificates(),
    ]);
    const quietMs = (await setting<number>("detection.agentQuietAfterMinutes")) * 60_000;
    const backupWorkerOnline = Boolean(backup?.workerHeartbeatAt && now - backup.workerHeartbeatAt.getTime() < 90_000);
    const diskFree = backup?.workerDiskFreeBytes ? Number(backup.workerDiskFreeBytes) : null;
    const diskTotal = backup?.workerDiskTotalBytes ? Number(backup.workerDiskTotalBytes) : null;

    const warnings: { level: "bad" | "note"; message: string }[] = [];
    for (const c of certs) {
      if (c.error) warnings.push({ level: "note", message: `${c.name} ${c.host}: couldn't read its certificate (${c.error})` });
      else if (c.expiresAt) {
        const days = Math.floor((Date.parse(c.expiresAt) - now) / DAY);
        if (days < 0) warnings.push({ level: "bad", message: `${c.name} ${c.host}: certificate expired ${-days} day(s) ago` });
        else if (days <= 30) warnings.push({ level: days <= 7 ? "bad" : "note", message: `${c.name} ${c.host}: certificate expires in ${days} day(s)` });
      }
    }
    if (!backupWorkerOnline) warnings.push({ level: "bad", message: "The backup worker isn't running" });
    if (!lastBackup?.finishedAt || now - lastBackup.finishedAt.getTime() > 2 * DAY) warnings.push({ level: "bad", message: "No successful backup in the last 48 hours" });
    if (diskFree !== null && diskTotal && diskFree / diskTotal < 0.1) warnings.push({ level: "bad", message: `Less than 10% disk space left where backups are kept` });
    if (pending > 5000) warnings.push({ level: "note", message: `${pending} files waiting to be classified` });

    return {
      warnings,
      database: { sizeBytes: Number(dbSize[0]?.size ?? 0) },
      backups: {
        workerOnline: backupWorkerOnline,
        workerLastSeenAt: backup?.workerHeartbeatAt ?? null,
        diskFreeBytes: diskFree,
        diskTotalBytes: diskTotal,
        lastSuccessAt: lastBackup?.finishedAt ?? null,
        lastUploaded: lastBackup?.uploaded ?? null,
        scheduleOn: backup?.enabled ?? false,
      },
      classification: { pending, lastProcessedAt: lastJob?.processedAt ?? null },
      agents: {
        active: agents.filter((a) => now - a.lastSeenAt.getTime() <= quietMs).length,
        quiet: agents.filter((a) => now - a.lastSeenAt.getTime() > quietMs).length,
        versions: [...new Set(agents.map((a) => a.version).filter(Boolean))],
      },
      certificates: certs,
    };
  });
}
