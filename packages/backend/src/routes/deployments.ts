import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MANAGED_SOURCES_CAPABILITY } from "@logikos-dsp/shared";
import { prisma } from "../db.js";
import { recordAudit } from "../audit.js";
import { forgetCredentials, hasCredentials, holdCredentials } from "../deployCredentials.js";

/**
 * Installing the agent on a machine remotely, from the dashboard.
 *
 * The credentials never reach the database: an account that can install a
 * service is administrator on the target, and a server holding one for every
 * workstation is worth attacking for its own sake. They are held in memory
 * until the agent collects the job (deployCredentials.ts) and dropped there.
 *
 * What *is* recorded is the attempt — which machine, which account name, who
 * asked, and what happened — because a remote install is exactly the kind of
 * act that should leave a trail.
 */

const deploySchema = z.object({
  address: z.string().min(7).max(45),
  hostname: z.string().max(255).nullish(),
  agentId: z.string().uuid(),
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
  watchPath: z.string().max(512).optional(),
  connectIp: z.string().max(45).optional(),
  allDrives: z.boolean().default(true),
  removable: z.boolean().default(true),
});

export async function deploymentRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  app.post("/deployments", { preHandler: app.requireRole("ADMIN") }, async (req, reply) => {
    const body = deploySchema.parse(req.body);

    const enrollToken = process.env.AGENT_ENROLL_TOKEN;
    if (!enrollToken) {
      return reply.code(500).send({ error: "this server has no agent enroll token configured" });
    }
    // Without this the installed agent would have nothing to report to, and
    // would fail on the target rather than here — where nobody is watching.
    const serverUrl = process.env.PUBLIC_BACKEND_URL;
    if (!serverUrl) {
      return reply.code(500).send({
        error: "this server doesn't know its own public URL (PUBLIC_BACKEND_URL), so it can't tell an agent where to report",
      });
    }

    const agent = await prisma.agent.findUnique({ where: { id: body.agentId } });
    if (!agent) return reply.code(404).send({ error: "unknown agent" });
    if (agent.revokedAt) return reply.code(400).send({ error: "that agent is revoked" });
    if (!agent.capabilities.includes(MANAGED_SOURCES_CAPABILITY)) {
      return reply.code(400).send({
        error: `${agent.hostname} can't deploy to other machines — it only watches files.`,
      });
    }

    // One at a time per machine: two installs racing on one target end with a
    // service half-configured by each.
    const inFlight = await prisma.deployment.findFirst({
      where: { address: body.address, status: { in: ["PENDING", "RUNNING"] } },
    });
    if (inFlight) return reply.code(409).send({ error: `a deployment to ${body.address} is already under way` });

    const deployment = await prisma.deployment.create({
      data: {
        address: body.address,
        hostname: body.hostname ?? null,
        username: body.username,
        agentId: agent.id,
        requestedBy: req.user.email,
      },
    });

    // Memory only. Note the order: the row exists first, so a crash between
    // the two leaves a visible failed deployment rather than a silent nothing.
    holdCredentials(deployment.id, { username: body.username, password: body.password });

    // The install arguments travel with the job rather than being stored,
    // since they're only meaningful for this one run.
    pendingInstallOptions.set(deployment.id, {
      serverUrl,
      enrollToken,
      watchPath: body.watchPath,
      connectIp: body.connectIp,
      allDrives: body.allDrives,
      removable: body.removable,
    });

    await recordAudit(req, "agent.deploy", { type: "Deployment", id: deployment.id }, {
      address: body.address,
      username: body.username,
      via: agent.hostname,
    });
    return reply.code(201).send(deployment);
  });

  app.get("/deployments", async () => {
    await expireUncollected();
    const deployments = await prisma.deployment.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { agent: { select: { hostname: true } } },
    });
    return deployments;
  });
}

/**
 * Install arguments for jobs not yet collected. Alongside the credentials and
 * for the same reason: they carry the enroll token, which is a credential too.
 */
export const pendingInstallOptions = new Map<
  string,
  {
    serverUrl: string;
    enrollToken: string;
    watchPath?: string;
    connectIp?: string;
    allDrives: boolean;
    removable: boolean;
  }
>();

/**
 * A job whose credentials have expired can never run, so it shouldn't sit at
 * "pending" implying otherwise. The dashboard is told plainly to try again —
 * which requires typing the password again, which is the whole design.
 */
async function expireUncollected(): Promise<void> {
  const pending = await prisma.deployment.findMany({ where: { status: "PENDING" }, select: { id: true } });
  const dead = pending.filter((d) => !hasCredentials(d.id)).map((d) => d.id);
  if (dead.length === 0) return;
  await prisma.deployment.updateMany({
    where: { id: { in: dead } },
    data: {
      status: "FAILED",
      message: "No agent collected this in time, so the credentials were discarded. Start it again.",
      completedAt: new Date(),
    },
  });
  for (const id of dead) {
    pendingInstallOptions.delete(id);
    forgetCredentials(id);
  }
}
