import os from "node:os";
import { createHash } from "node:crypto";
import { CLASSIFICATION_JOB_MAX_SAMPLE_BYTES } from "@logikos-dsp/shared";

type SourceType = "local" | "smb" | "m365";

const sourceType = (process.env.SOURCE_TYPE ?? "local") as SourceType;
if (sourceType !== "local" && sourceType !== "smb" && sourceType !== "m365") {
  console.error(`SOURCE_TYPE must be "local", "smb", or "m365", got "${sourceType}"`);
  process.exit(1);
}

const watchPath = process.env.WATCH_PATH;
if (sourceType === "local" && !watchPath) {
  console.error("WATCH_PATH environment variable is required when SOURCE_TYPE=local");
  process.exit(1);
}

const smb = {
  host: process.env.SMB_HOST,
  share: process.env.SMB_SHARE,
  subPath: process.env.SMB_SUBPATH,
  username: process.env.SMB_USERNAME,
  password: process.env.SMB_PASSWORD,
  domain: process.env.SMB_DOMAIN,
  port: process.env.SMB_PORT ? Number(process.env.SMB_PORT) : undefined,
};
if (sourceType === "smb") {
  const missing = (["host", "share", "username", "password"] as const).filter((k) => !smb[k]);
  if (missing.length > 0) {
    console.error(`SOURCE_TYPE=smb requires SMB_${missing.map((k) => k.toUpperCase()).join(", SMB_")}`);
    process.exit(1);
  }
}

const m365 = {
  tenantId: process.env.M365_TENANT_ID,
  clientId: process.env.M365_CLIENT_ID,
  clientSecret: process.env.M365_CLIENT_SECRET,
  driveId: process.env.M365_DRIVE_ID,
  subPath: process.env.M365_SUBPATH,
};
if (sourceType === "m365") {
  const missing = (["tenantId", "clientId", "clientSecret", "driveId"] as const).filter((k) => !m365[k]);
  if (missing.length > 0) {
    console.error(
      `SOURCE_TYPE=m365 requires M365_${missing.map((k) => k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()).join(", M365_")}`,
    );
    process.exit(1);
  }
}

// Deterministic per (host, source) so restarting the agent re-registers under
// the same key instead of minting a new Agent row every time.
const sourceDescriptor =
  sourceType === "local"
    ? `local:${watchPath}`
    : sourceType === "smb"
      ? `smb:${smb.host}:${smb.share}:${smb.subPath ?? ""}`
      : `m365:${m365.driveId}:${m365.subPath ?? ""}`;
const derivedKey = `agent-${createHash("sha256").update(`${os.hostname()}:${sourceDescriptor}`).digest("hex").slice(0, 24)}`;

// Sent to the backend as Agent.watchedRoot — display only, never includes credentials.
const watchedRootLabel =
  sourceType === "local"
    ? (watchPath as string)
    : sourceType === "smb"
      ? `smb://${smb.host}/${smb.share}${smb.subPath ? `/${smb.subPath.replace(/^\/+/, "")}` : ""}`
      : `m365://${m365.driveId}${m365.subPath ? `/${m365.subPath.replace(/^\/+/, "")}` : ""}`;

export const config = {
  backendUrl: process.env.BACKEND_URL ?? "http://localhost:4000",
  sourceType,
  watchPath: watchPath as string, // only read when sourceType === "local"
  watchedRootLabel,
  smb: smb as { host: string; share: string; subPath?: string; username: string; password: string; domain?: string; port?: number },
  m365: m365 as { tenantId: string; clientId: string; clientSecret: string; driveId: string; subPath?: string },
  agentKey: process.env.AGENT_KEY ?? derivedKey,
  hostname: os.hostname(),
  storageScanIntervalMs: Number(process.env.STORAGE_SCAN_INTERVAL_MS ?? 60_000),
  smbScanIntervalMs: Number(process.env.SMB_SCAN_INTERVAL_MS ?? 30_000),
  m365ScanIntervalMs: Number(process.env.M365_SCAN_INTERVAL_MS ?? 60_000),
  quarantinePollIntervalMs: Number(process.env.QUARANTINE_POLL_INTERVAL_MS ?? 10_000),
  eventFlushIntervalMs: Number(process.env.EVENT_FLUSH_INTERVAL_MS ?? 500),
  eventBatchSize: 50,
  maxContentSampleBytes: CLASSIFICATION_JOB_MAX_SAMPLE_BYTES,
};
