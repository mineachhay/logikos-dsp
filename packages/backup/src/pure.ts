/** Pure helpers for the worker, split out so they're testable without Postgres, rclone or age. */

/** libpq environment for pg_dump/pg_restore/createdb — keeps the password off the command line. */
export function pgEnvFromUrl(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, ""),
  };
}

export interface TableCounts {
  [table: string]: number;
}

/**
 * Judges a restore check. Live counts keep moving after the dump (new events
 * arrive), so equal counts aren't the bar. It fails if a table the live
 * database has is missing from the restore, or if the restore came back empty
 * while the live database isn't — the two ways a dump is actually useless.
 */
export function evaluateRestore(restored: TableCounts, live: TableCounts): { ok: boolean; summary: string } {
  const missing = Object.keys(live).filter((t) => !(t in restored) && !t.startsWith("_prisma"));
  const restoredRows = Object.values(restored).reduce((a, b) => a + b, 0);
  const liveRows = Object.values(live).reduce((a, b) => a + b, 0);
  const tables = Object.keys(restored).length;
  if (missing.length > 0) {
    return { ok: false, summary: `restore is missing table(s): ${missing.join(", ")}` };
  }
  if (restoredRows === 0 && liveRows > 0) {
    return { ok: false, summary: `restore has no rows but the live database has ${liveRows}` };
  }
  return { ok: true, summary: `restored ${tables} tables, ${restoredRows} rows (live now: ${liveRows})` };
}

/**
 * rclone retries and logs every attempt, so its raw stderr is three copies of
 * a request id. Turn it into one line an admin can act on — the dashboard and
 * the Telegram alert show this — keeping the tool's own last error after it.
 */
export function describeRcloneError(raw: string): string {
  // Drive errors embed the full request URL (hundreds of characters of query
  // string) ahead of the actual reason; keep just the host.
  const lines = raw
    .replace(/"(https?:\/\/[^/"]+)[^"]*"/g, '"$1/…"')
    .split("\n")
    .map((l) => l.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} (ERROR|NOTICE|CRITICAL|Failed)?\s*:?\s*/, "").trim())
    .filter(Boolean);
  const last =
    [...lines].reverse().find((l) => /Failed to|error|denied|refused|not found|unable/i.test(l)) ?? lines.at(-1) ?? raw.trim();
  const detail = last.replace(/,? ?(RequestID|HostID): [^,]+/g, "").replace(/Attempt \d+\/\d+ failed with \d+ errors and: /, "");

  const hints: [RegExp, string][] = [
    [/StatusCode: 403|AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId|Forbidden/i, "access denied — check the access key, secret and that the key can write to this bucket"],
    [/NoSuchBucket|bucket does not exist|StatusCode: 404.*bucket/i, "bucket not found — check the bucket name and endpoint (it isn't created automatically)"],
    [/no such host|dial tcp|connection refused|i\/o timeout|network is unreachable|context deadline exceeded/i, "can't reach the destination — check the host/endpoint and that this server can connect to it"],
    [/knownhosts: key mismatch|host key mismatch/i, "the server's host key doesn't match the pinned one — possible interception, or the server's key changed"],
    [/knownhosts: key is unknown/i, "the server's host key isn't in the pinned host key — paste its `ssh-keyscan` line"],
    [/unable to authenticate|permission denied \(|handshake failed/i, "SFTP login failed — check the username, password or private key"],
    [/private key should be a PEM|invalid_client|Invalid JWT|client_email/i, "Google Drive service account key is invalid — paste the whole JSON key file for the service account"],
    [/storageQuotaExceeded|Service Accounts do not have storage quota/i, "Google Drive refused: service accounts have no storage — use a Shared drive, or OAuth token mode"],
    [/invalid_grant|token expired|oauth2: cannot fetch token/i, "Google Drive login failed — the OAuth token is invalid or revoked; run `rclone authorize \"drive\"` again"],
    [/File not found|notFound|404/i, "folder not found on Google Drive — check the folder or Shared drive id and that the account can access it"],
  ];
  const hint = hints.find(([re]) => re.test(raw))?.[1];
  return shortMessage(hint ? `${hint} (${detail})` : detail, 600);
}

/** Trims tool output for storing as a run message. */
export function shortMessage(text: string, max = 1500): string {
  const clean = text.replace(/\s+$/g, "").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export const RESTORE_README = `logikos-dsp backup bundle
=========================

This file was decrypted with your age private key. It contains:

  logikos_dsp.dump   Postgres custom-format dump (pg_dump -Fc) of the whole database
  backend.env        the backend's env file (JWT_SECRET, SOURCE_CREDENTIALS_KEY, ...)
  root.env           the deployment's root .env (AGENT_ENROLL_TOKEN, DASHBOARD_BACKEND_URL, ...)
  manifest.json      what was backed up, when, with SHA-256 checksums

Rebuild on a new host:

  1. Clone the repo and put backend.env where BACKEND_ENV_FILE points (or
     packages/backend/.env) and root.env at the repo root as .env.
  2. docker compose up -d postgres
  3. docker compose exec -T postgres pg_restore -U logikos -d logikos_dsp --clean --if-exists --no-owner < logikos_dsp.dump
  4. docker compose up -d --build

The env files must be the ones from this bundle: SOURCE_CREDENTIALS_KEY is what
decrypts the file-server and backup-destination passwords stored in the dump.
`;
