const BASE = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function patchAlertStatus(id: string, status: string): Promise<void> {
  await patchJson(`/alerts/${id}`, { status });
}

export type Role = "ADMIN" | "VIEWER";

export interface CurrentUser {
  id: string;
  email: string;
  role: Role;
}

export async function login(email: string, password: string): Promise<CurrentUser> {
  return postJson<CurrentUser>("/auth/login", { email, password });
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: "POST", credentials: "include" });
}

export async function fetchMe(): Promise<CurrentUser> {
  return fetchJson<CurrentUser>("/auth/me");
}

export interface ManagedUser {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export async function listUsers(): Promise<ManagedUser[]> {
  return fetchJson<ManagedUser[]>("/users");
}

export async function createUser(email: string, password: string, role: Role): Promise<ManagedUser> {
  return postJson<ManagedUser>("/users", { email, password, role });
}

export interface ResponseAction {
  id: string;
  type: "WEBHOOK_NOTIFICATION" | "FILE_QUARANTINE";
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";
  resultMessage: string | null;
}

export interface Alert {
  id: string;
  type: "RANSOMWARE_RATE" | "SENSITIVE_DATA_EXPOSED";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  message: string;
  createdAt: string;
  agent: { hostname: string; watchedRoot: string } | null;
  responseActions: ResponseAction[];
}

export async function approveResponseAction(id: string): Promise<ResponseAction> {
  return postJson<ResponseAction>(`/response-actions/${id}/approve`, {});
}

export async function rejectResponseAction(id: string): Promise<ResponseAction> {
  return postJson<ResponseAction>(`/response-actions/${id}/reject`, {});
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

export interface Overview {
  alerts: {
    openBySeverity: Partial<Record<Alert["severity"], number>>;
    openTotal: number;
  };
  agents: { total: number; activeLast24h: number };
  storage: { totalBytes: string; fileCount: number };
  eventsLast24h: number;
  alertTrend: { date: string; count: number }[];
  matchesByPattern: { patternType: string; count: number }[];
  recentAlerts: Alert[];
}
