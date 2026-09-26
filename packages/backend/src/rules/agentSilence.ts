import { MANAGED_SOURCES_CAPABILITY } from "@logikos-dsp/shared";
import { prisma } from "../db.js";

/**
 * An agent that scans file shares checks in every ~10 seconds (/agent-sync).
 * Silence for this long means the shares it scans aren't being watched — and
 * silence reads exactly like "nothing happened", so it has to be said out loud.
 * Only share-scanning agents: a workstation agent going quiet overnight is a
 * laptop being shut, not an outage, and would bury this in noise.
 */
export const SCANNER_SILENT_AFTER_MS = 15 * 60 * 1000;

export function isSilent(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() > SCANNER_SILENT_AFTER_MS;
}

/**
 * Raises one AGENT_SILENT alert per outage and resolves it when the agent
 * reports again. Run periodically from index.ts (never from app.ts, so tests
 * don't start the timer).
 */
export async function checkSilentAgents(now = new Date()): Promise<{ raised: number; resolved: number }> {
  const agents = await prisma.agent.findMany({
    where: { revokedAt: null, capabilities: { has: MANAGED_SOURCES_CAPABILITY } },
    include: { sources: { where: { fileServerId: { not: null }, enabled: true }, select: { rootLabel: true } } },
  });
  let raised = 0;
  let resolved = 0;
  for (const agent of agents) {
    const open = await prisma.alert.findFirst({
      where: { type: "AGENT_SILENT", agentId: agent.id, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    });
    if (isSilent(agent.lastSeenAt, now)) {
      if (open) continue;
      const minutes = Math.round((now.getTime() - agent.lastSeenAt.getTime()) / 60_000);
      const shares = agent.sources.map((s) => s.rootLabel);
      const alert = await prisma.alert.create({
        data: {
          type: "AGENT_SILENT",
          severity: "HIGH",
          agentId: agent.id,
          message:
            `${agent.hostname} hasn't reported for ${minutes} minutes` +
            (shares.length ? ` — ${shares.length} share(s) aren't being monitored: ${shares.slice(0, 5).join(", ")}${shares.length > 5 ? ", …" : ""}` : ""),
          metadata: { hostname: agent.hostname, lastSeenAt: agent.lastSeenAt.toISOString(), shares },
        },
      });
      // Every HIGH/CRITICAL alert gets a pending notification (see CLAUDE.md).
      await prisma.responseAction.create({ data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" } });
      raised++;
    } else if (open) {
      await prisma.alert.update({
        where: { id: open.id },
        data: { status: "RESOLVED", metadata: { ...(open.metadata as object), resolvedAt: now.toISOString(), resolvedBy: "agent reported again" } },
      });
      resolved++;
    }
  }
  return { raised, resolved };
}
