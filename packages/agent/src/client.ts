import type { FileEventInput, StorageSnapshotInput } from "@logikos-dsp/shared";
import { config } from "./config.js";

export async function registerAgent(): Promise<void> {
  const res = await fetch(`${config.backendUrl}/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: config.agentKey,
      hostname: config.hostname,
      watchedRoot: config.watchPath,
    }),
  });
  if (!res.ok) {
    throw new Error(`agent registration failed: ${res.status} ${await res.text()}`);
  }
  console.log(`registered agent ${config.agentKey} watching ${config.watchPath}`);
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
