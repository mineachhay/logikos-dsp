const BASE = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function patchAlertStatus(id: string, status: string): Promise<void> {
  const res = await fetch(`${BASE}/alerts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`PATCH /alerts/${id} -> ${res.status}`);
}

export interface Alert {
  id: string;
  type: "RANSOMWARE_RATE" | "SENSITIVE_DATA_EXPOSED";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  message: string;
  createdAt: string;
  agent: { hostname: string; watchedRoot: string } | null;
}

export interface FileEvent {
  id: string;
  eventType: string;
  path: string;
  sizeBytes: number | null;
  occurredAt: string;
  agent: { hostname: string; watchedRoot: string };
}

export interface StorageSnapshot {
  id: string;
  rootPath: string;
  totalBytes: string;
  fileCount: number;
  takenAt: string;
  agent: { hostname: string; watchedRoot: string };
}

export interface ClassificationMatch {
  id: string;
  patternType: string;
  redactedSample: string;
  path: string;
  createdAt: string;
}
