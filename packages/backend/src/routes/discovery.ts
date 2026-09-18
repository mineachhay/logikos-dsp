import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { coverageFor, MANAGED_SOURCES_CAPABILITY, parseCidr } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { recordAudit } from "../audit.js";

/**
 * "Which machines are on this network, and which of them have no agent?"
 *
 * The backend can no more scan a network than it can talk SMB, so a scan is
 * queued for an agent to run — the same shape as a connection test. That also
 * puts the scan on the right side of the network: the agent is on the segment
 * being swept, while the backend may be behind a proxy in another VLAN
 * entirely.
 *
 * Deliberately not a credentialed Active Directory query, for now: the first
 * environment this ran against is a workgroup, where AD would return nothing,
 * and a TCP sweep needs no account at all. AD enumeration is the better source
 * in a domain and can be added beside this.
 */

const createSchema = z.object({
  cidr: z.string().min(7).max(20),
  agentId: z.string().uuid(),
});

export async function discoveryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.post("/discovery/scans", { preHandler: app.requireRole("ADMIN") }, async (req, reply) => {
    const body = createSchema.parse(req.body);

    // Parsed here rather than in the agent so a bad range is refused while
    // someone is looking at the screen, and so the cap on how much may be
    // swept is enforced by the server, not by whatever is asking.
    const parsed = parseCidr(body.cidr);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const agent = await prisma.agent.findUnique({ where: { id: body.agentId } });
    if (!agent) return reply.code(404).send({ error: "unknown agent" });
    if (agent.revokedAt) return reply.code(400).send({ error: "that agent is revoked" });
    // Only agents that poll /agent-sync ever see queued work. The Go agent
    // doesn't: it watches files and reports them, nothing else. Accepting a
    // scan for one leaves it PENDING forever with nothing to explain why —
    // which is exactly what happened the first time this shipped.
    if (!agent.capabilities.includes(MANAGED_SOURCES_CAPABILITY)) {
      return reply.code(400).send({
        error: `${agent.hostname} can't run network scans — it only watches files. Choose an agent that manages shares.`,
      });
    }

    const scan = await prisma.discoveryScan.create({
      data: { cidr: parsed.value.cidr, agentId: agent.id, requestedBy: req.user.email },
    });
    await recordAudit(req, "discovery.scan", { type: "DiscoveryScan", id: scan.id }, { cidr: parsed.value.cidr, agent: agent.hostname });
    return reply.code(201).send(scan);
  });

  app.get("/discovery/scans", async () => {
    await expireStuckScans();
    return prisma.discoveryScan.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        agent: { select: { hostname: true } },
        _count: { select: { hosts: true } },
      },
    });
  });

  /**
   * The coverage report: the most recent finished scan, joined against every
   * agent that has registered. This is the answer the page exists to give —
   * not "what is on the network" but "what on the network is unprotected".
   */
  app.get("/discovery/coverage", async () => {
    const scan = await prisma.discoveryScan.findFirst({
      where: { status: "SUCCEEDED" },
      orderBy: { completedAt: "desc" },
      include: { hosts: { orderBy: { address: "asc" } }, agent: { select: { hostname: true } } },
    });
    if (!scan) return { scan: null, machines: [] };

    const agents = await prisma.agent.findMany({ select: { hostname: true, lastSeenAt: true, revokedAt: true, lastIp: true } });
    const machines = coverageFor(
      scan.hosts.map((h) => ({ address: h.address, hostname: h.hostname, openPorts: h.openPorts })),
      agents,
    );
    return {
      scan: { id: scan.id, cidr: scan.cidr, completedAt: scan.completedAt, scannedBy: scan.agent.hostname },
      machines,
    };
  });
}

/**
 * How long a scan may sit unclaimed before it is written off. A capable agent
 * polls every ten seconds and a /24 sweep takes a few more, so minutes of
 * silence means nobody is coming — the agent is stopped, unreachable, or was
 * revoked between queueing and running.
 */
const SCAN_GIVE_UP_MS = 5 * 60 * 1000;

/**
 * Without this a scan nothing picked up stays PENDING forever, and the
 * dashboard shows "Scanning…" indefinitely with no way to tell that nothing is
 * actually happening. Swept lazily on read rather than by a timer: there is no
 * work to do when nobody is looking.
 */
async function expireStuckScans(now = new Date()): Promise<void> {
  await prisma.discoveryScan.updateMany({
    where: { status: { in: ["PENDING", "RUNNING"] }, createdAt: { lt: new Date(now.getTime() - SCAN_GIVE_UP_MS) } },
    data: {
      status: "FAILED",
      message: "No agent picked this up. Check that the agent chosen is running and connected.",
      completedAt: now,
    },
  });
}
