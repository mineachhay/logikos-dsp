import type { Agent, Source } from "@prisma/client";
import { sourceKindFromRoot } from "@logikos-dsp/shared";
import { prisma } from "./db.js";

/**
 * An agent's own env-configured root (WATCH_PATH, or SOURCE_TYPE=smb/m365/...),
 * as a Source: the one with no fileServerId. Created or relabelled at every
 * registration, so a changed WATCH_PATH moves the label rather than minting a
 * second default source.
 */
export async function upsertDefaultSource(agent: Agent): Promise<Source> {
  const existing = await prisma.source.findFirst({ where: { agentId: agent.id, fileServerId: null } });
  const data = { kind: sourceKindFromRoot(agent.watchedRoot), rootLabel: agent.watchedRoot };
  return existing
    ? prisma.source.update({ where: { id: existing.id }, data })
    : prisma.source.create({ data: { ...data, agentId: agent.id } });
}

/**
 * Which Source an agent's ingest call is about. No sourceId means its default
 * source (every agent that predates managed sources, and the Go agent). A
 * sourceId must be a source currently assigned to this agent — otherwise an
 * agent could write into another agent's shares.
 */
export async function resolveIngestSource(agent: Agent, sourceId: string | undefined): Promise<Source | null> {
  if (!sourceId) {
    return (
      (await prisma.source.findFirst({ where: { agentId: agent.id, fileServerId: null } })) ??
      (await upsertDefaultSource(agent))
    );
  }
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  return source && source.agentId === agent.id ? source : null;
}
