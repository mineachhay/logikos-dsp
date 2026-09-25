import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ActivityCollectorConfig, AgentSyncResponse } from "@logikos-dsp/shared";
import { DISCOVERY_PORTS, MAX_UNREADABLE_FOLDERS, parseCidr } from "@logikos-dsp/shared";
import type { PendingDeployment } from "@logikos-dsp/shared";
import { takeCredentials } from "../deployCredentials.js";
import { pendingInstallOptions } from "./deployments.js";
import { prisma } from "../db.js";
import { authenticateAgent } from "../auth/agentAuth.js";
import { decryptSecret } from "@logikos-dsp/shared/credentials";

const discoveryResultSchema = z.object({
  agentKey: z.string().min(8),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  message: z.string().max(500).optional(),
  hosts: z
    .array(
      z.object({
        address: z.string().max(45),
        hostname: z.string().max(255).nullish(),
        openPorts: z.array(z.number().int().min(1).max(65535)).max(16),
      }),
    )
    .max(1024),
});

const statusSchema = z.object({
  agentKey: z.string().min(8),
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
  fileCount: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  // Subfolders skipped as unreadable. The agent sends at most
  // MAX_UNREADABLE_FOLDERS names plus the true count.
  unreadableFolders: z.array(z.string().max(1024)).max(MAX_UNREADABLE_FOLDERS).optional(),
  unreadableFolderCount: z.number().int().nonnegative().optional(),
});

const testCompleteSchema = z.object({
  agentKey: z.string().min(8),
  success: z.boolean(),
  message: z.string().min(1).max(2000),
});

/**
 * Agent-facing (auth/agentAuth.ts, never the user JWT). Agents with the
 * managed-sources capability poll GET /agent-sync for the dashboard-configured
 * shares assigned to them, reconcile their running scans against it, and run
 * any pending connection tests. This is the only place share passwords are
 * decrypted, and only for the agent the share is assigned to.
 */
export async function agentSyncRoutes(app: FastifyInstance) {
  app.get("/agent-sync", async (req, reply) => {
    const { agentKey } = z.object({ agentKey: z.string().min(8) }).parse(req.query);
    const agent = await authenticateAgent(req, reply, agentKey);
    if (!agent) return reply;

    const [sources, tests, activityServers, pendingScans, pendingDeployments] = await Promise.all([
      prisma.source.findMany({
        where: { agentId: agent.id, enabled: true, fileServer: { enabled: true } },
        include: { fileServer: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.connectionTest.findMany({
        where: { agentId: agent.id, status: "PENDING" },
        include: { fileServer: true },
        orderBy: { createdAt: "asc" },
      }),
      // Windows servers whose activity this agent collects: enabled, and at
      // least one of their shares assigned here.
      prisma.fileServer.findMany({
        where: { enabled: true, activityEnabled: true, shares: { some: { agentId: agent.id, enabled: true } } },
        include: { shares: { where: { agentId: agent.id, enabled: true } } },
      }),
      prisma.discoveryScan.findMany({
        where: { agentId: agent.id, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: 3,
      }),
      prisma.deployment.findMany({
        where: { agentId: agent.id, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: 5,
      }),
    ]);

    // The addresses are expanded here, not in the agent: the cap on how much
    // may be swept is the server's to enforce, and an agent should never be
    // handed a range it has to interpret.
    const discoveryScans = pendingScans.flatMap((scan) => {
      const parsed = parseCidr(scan.cidr);
      return parsed.ok ? [{ id: scan.id, addresses: parsed.value.addresses, ports: [...DISCOVERY_PORTS] }] : [];
    });

    // Handing a deployment over takes its credentials out of memory: the
    // backend stops knowing the password the moment an agent has it, and a
    // job collected twice would have nothing to run with the second time.
    const deployments: PendingDeployment[] = [];
    for (const job of pendingDeployments) {
      const credentials = takeCredentials(job.id);
      const install = pendingInstallOptions.get(job.id);
      if (!credentials || !install) continue; // expired; the dashboard reports it
      pendingInstallOptions.delete(job.id);
      deployments.push({
        id: job.id,
        address: job.address,
        username: credentials.username,
        password: credentials.password,
        install,
      });
      await prisma.deployment.update({ where: { id: job.id }, data: { status: "RUNNING", startedAt: new Date() } });
    }

    const response: AgentSyncResponse = {
      sources: sources.map((s) => ({
        id: s.id,
        kind: "SMB" as const,
        rootLabel: s.rootLabel,
        host: s.fileServer!.host,
        port: s.fileServer!.port ?? undefined,
        domain: s.fileServer!.domain ?? undefined,
        username: s.fileServer!.username,
        password: decryptSecret(s.fileServer!.passwordEnc),
        share: s.shareName!,
        subPath: s.subPath,
        scanIntervalSec: s.scanIntervalSec,
      })),
      activityCollectors: activityServers.map(
        (fs): ActivityCollectorConfig => ({
          fileServerId: fs.id,
          host: fs.host,
          winrmPort: fs.winrmPort ?? 5985,
          // Falls back to the share account when no separate WinRM account is
          // set — qualified with the server's domain, because WinRM's NTLM has
          // no separate domain field: a bare "administrator" is checked against
          // the file server's *local* accounts, so a domain share account that
          // logs on fine over SMB failed here with "Failed to authenticate".
          // A separate WinRM account is used exactly as typed (it may be local).
          username: fs.winrmUsername || qualifiedAccount(fs.domain, fs.username),
          password: decryptSecret(fs.winrmPasswordEnc ?? fs.passwordEnc),
          scanAccount: fs.username,
          recordReads: fs.recordReads,
          bookmark: fs.activityBookmark === null ? null : Number(fs.activityBookmark),
          shares: fs.shares.map((s) => ({ sourceId: s.id, shareName: s.shareName!, subPath: s.subPath })),
        }),
      ),
      connectionTests: tests.map((t) => ({
        id: t.id,
        host: t.fileServer.host,
        port: t.fileServer.port ?? undefined,
        domain: t.fileServer.domain ?? undefined,
        username: t.fileServer.username,
        password: decryptSecret(t.fileServer.passwordEnc),
        share: t.shareName,
        subPath: t.subPath,
      })),
      discoveryScans,
      deployments,
    };
    return reply.send(response);
  });

  // Reported once a network sweep finishes. Results replace whatever that scan
  // had, so a retry can't leave half of one run mixed with half of another.
  app.post<{ Params: { id: string } }>("/agent-sync/discovery/:id/results", async (req, reply) => {
    const body = discoveryResultSchema.parse(req.body);
    const agent = await authenticateAgent(req, reply, body.agentKey);
    if (!agent) return reply;

    const scan = await prisma.discoveryScan.findUnique({ where: { id: req.params.id } });
    if (!scan || scan.agentId !== agent.id) {
      return reply.code(404).send({ error: "scan not found" });
    }

    await prisma.$transaction([
      prisma.discoveredHost.deleteMany({ where: { scanId: scan.id } }),
      prisma.discoveredHost.createMany({
        data: body.hosts.map((host) => ({
          scanId: scan.id,
          address: host.address,
          hostname: host.hostname ?? null,
          openPorts: host.openPorts,
        })),
        skipDuplicates: true,
      }),
      prisma.discoveryScan.update({
        where: { id: scan.id },
        data: { status: body.status, message: body.message, completedAt: new Date() },
      }),
    ]);
    return reply.send({ ok: true, hosts: body.hosts.length });
  });

  // Reported once a remote install finishes, succeeded or not.
  app.post<{ Params: { id: string } }>("/agent-sync/deployments/:id/result", async (req, reply) => {
    const body = z
      .object({
        agentKey: z.string().min(8),
        success: z.boolean(),
        message: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const agent = await authenticateAgent(req, reply, body.agentKey);
    if (!agent) return reply;

    const deployment = await prisma.deployment.findUnique({ where: { id: req.params.id } });
    if (!deployment || deployment.agentId !== agent.id) {
      return reply.code(404).send({ error: "deployment not found" });
    }

    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: body.success ? "SUCCEEDED" : "FAILED",
        message: body.message?.slice(0, 2000),
        completedAt: new Date(),
      },
    });
    return reply.send({ ok: true });
  });

  // Marks a scan as started, so a long sweep doesn't look stuck at "pending".
  app.post<{ Params: { id: string } }>("/agent-sync/discovery/:id/started", async (req, reply) => {
    const { agentKey } = z.object({ agentKey: z.string().min(8) }).parse(req.body);
    const agent = await authenticateAgent(req, reply, agentKey);
    if (!agent) return reply;

    const scan = await prisma.discoveryScan.findUnique({ where: { id: req.params.id } });
    if (!scan || scan.agentId !== agent.id) return reply.code(404).send({ error: "scan not found" });

    await prisma.discoveryScan.update({ where: { id: scan.id }, data: { status: "RUNNING", startedAt: new Date() } });
    return reply.send({ ok: true });
  });

  // Reported after every scan of a managed share — this is what the dashboard
  // shows as "last scan / N files / error".
  app.post<{ Params: { id: string } }>("/agent-sync/sources/:id/status", async (req, reply) => {
    const body = statusSchema.parse(req.body);
    const agent = await authenticateAgent(req, reply, body.agentKey);
    if (!agent) return reply;

    const source = await prisma.source.findUnique({ where: { id: req.params.id } });
    if (!source || source.agentId !== agent.id) {
      return reply.code(404).send({ error: "source not found" });
    }
    await prisma.source.update({
      where: { id: source.id },
      data: body.ok
        ? {
            lastScanAt: new Date(),
            lastScanError: null,
            lastFileCount: body.fileCount,
            lastTotalBytes: body.totalBytes === undefined ? undefined : BigInt(body.totalBytes),
            // Replaced on every successful scan, so the warning clears itself
            // once permissions are fixed. A failed scan leaves the last list:
            // it learned nothing about which folders are readable.
            unreadableFolders: body.unreadableFolders ?? [],
            unreadableFolderCount: body.unreadableFolderCount ?? body.unreadableFolders?.length ?? 0,
          }
        : { lastScanAt: new Date(), lastScanError: body.error ?? "scan failed" },
    });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/agent-sync/connection-tests/:id/complete", async (req, reply) => {
    const body = testCompleteSchema.parse(req.body);
    const agent = await authenticateAgent(req, reply, body.agentKey);
    if (!agent) return reply;

    const test = await prisma.connectionTest.findUnique({ where: { id: req.params.id } });
    if (!test || test.agentId !== agent.id || test.status !== "PENDING") {
      return reply.code(404).send({ error: "connection test not found" });
    }
    await prisma.connectionTest.update({
      where: { id: test.id },
      data: { status: body.success ? "SUCCEEDED" : "FAILED", message: body.message, completedAt: new Date() },
    });
    return reply.send({ ok: true });
  });
}

/** `DOMAIN\user` for NTLM clients with no domain field, unless already qualified. */
export function qualifiedAccount(domain: string | null, username: string): string {
  if (!domain || username.includes("\\") || username.includes("@")) return username;
  return `${domain}\\${username}`;
}
