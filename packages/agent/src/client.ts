import type { FileEventInput, StorageSnapshotInput } from "@logikos-dsp/shared";
import { config } from "./config.js";

export async function registerAgent(): Promise<void> {
  const res = await fetch(`${config.backendUrl}/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: config.agentKey,
      hostname: config.hostname,
      watchedRoot: config.watchedRootLabel,
    }),
  });
  if (!res.ok) {
    throw new Error(`agent registration failed: ${res.status} ${await res.text()}`);
  }
  console.log(`registered agent ${config.agentKey} watching ${config.watchedRootLabel}`);
}

export async function postEvents(events: FileEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const res = await fetch(`${config.backendUrl}/ingest/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(events),
  });
  if (!res.ok) {
    console.error(`failed to post ${events.length} event(s): ${res.status} ${await res.text()}`);
  }
}

export async function postStorageSnapshot(snapshot: StorageSnapshotInput): Promise<void> {
  const res = await fetch(`${config.backendUrl}/ingest/storage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) {
    console.error(`failed to post storage snapshot: ${res.status} ${await res.text()}`);
  }
}

export interface QuarantineCommand {
  id: string;
  path: string;
}

export async function fetchQuarantineCommands(): Promise<QuarantineCommand[]> {
  const url = new URL(`${config.backendUrl}/agent-commands`);
  url.searchParams.set("agentKey", config.agentKey);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`failed to fetch quarantine commands: ${res.status} ${await res.text()}`);
    return [];
  }
  return res.json();
}

export async function completeQuarantineCommand(id: string, success: boolean, message: string): Promise<void> {
  const res = await fetch(`${config.backendUrl}/agent-commands/${id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentKey: config.agentKey, success, message }),
  });
  if (!res.ok) {
    console.error(`failed to report quarantine command ${id}: ${res.status} ${await res.text()}`);
  }
}
