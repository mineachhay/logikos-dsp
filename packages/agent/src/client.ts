import type { AgentRegisterInput, AgentRegisterResponse, FileEventInput, StorageSnapshotInput } from "@logikos-dsp/shared";
import { config } from "./config.js";
import { createAgentSession } from "./agentSession.js";

async function register(): Promise<string> {
  const res = await fetch(`${config.backendUrl}/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.enrollToken}` },
    body: JSON.stringify({
      key: config.agentKey,
      hostname: config.hostname,
      watchedRoot: config.watchedRootLabel,
    } satisfies AgentRegisterInput),
  });
  if (!res.ok) {
    throw new Error(`agent registration failed: ${res.status} ${await res.text()}`);
  }
  console.log(`registered agent ${config.agentKey} watching ${config.watchedRootLabel}`);
  const { agentSecret } = (await res.json()) as AgentRegisterResponse;
  return agentSecret;
}

const session = createAgentSession({ register });

export function registerAgent(): Promise<void> {
  return session.start();
}

function postJson(path: string, body: unknown): Promise<Response> {
  return session.request((authorization) =>
    fetch(`${config.backendUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(body),
    }),
  );
}

export async function postEvents(events: FileEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const res = await postJson("/ingest/events", events);
  if (!res.ok) {
    console.error(`failed to post ${events.length} event(s): ${res.status} ${await res.text()}`);
  }
}

export async function postStorageSnapshot(snapshot: StorageSnapshotInput): Promise<void> {
  const res = await postJson("/ingest/storage", snapshot);
  if (!res.ok) {
    console.error(`failed to post storage snapshot: ${res.status} ${await res.text()}`);
  }
}

export interface QuarantineCommand {
  id: string;
  /**
   * One path for a SENSITIVE_DATA_EXPOSED-triggered quarantine, several for
   * a RANSOMWARE_RATE burst (every file the rule saw touched in the window
   * — see ARCHITECTURE.md). Always an array so the agent has one code path
   * for both instead of a single-path special case plus a separate
   * multi-path one.
   */
  paths: string[];
}

export async function fetchQuarantineCommands(): Promise<QuarantineCommand[]> {
  const url = new URL(`${config.backendUrl}/agent-commands`);
  url.searchParams.set("agentKey", config.agentKey);
  const res = await session.request((authorization) => fetch(url, { headers: { authorization } }));
  if (!res.ok) {
    console.error(`failed to fetch quarantine commands: ${res.status} ${await res.text()}`);
    return [];
  }
  return res.json();
}

export async function completeQuarantineCommand(id: string, success: boolean, message: string): Promise<void> {
  const res = await postJson(`/agent-commands/${id}/complete`, { agentKey: config.agentKey, success, message });
  if (!res.ok) {
    console.error(`failed to report quarantine command ${id}: ${res.status} ${await res.text()}`);
  }
}
