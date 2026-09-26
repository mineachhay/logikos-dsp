// LDAP I/O for signing in with Active Directory accounts. The rules it applies
// (filters, disabled flag, group → role, empty-password refusal) are in
// directory.ts, which is unit tested; this file is exercised against a real
// Samba AD domain controller (see ARCHITECTURE.md "Directory sign-in").
import { isIP } from "node:net";
import { Client, InvalidCredentialsError } from "ldapts";
import type { Entry } from "ldapts";
import { decryptSecret } from "@logikos-dsp/shared/credentials";
import { prisma } from "../db.js";
import {
  baseDnForDomain,
  directoryEmail,
  formatGuid,
  groupFilter,
  isDisabled,
  isUsablePassword,
  looksLikeDn,
  memberOfFilter,
  parseLoginName,
  roleFor,
  userFilter,
} from "./directory.js";
import type { DirectoryRole } from "./directory.js";

export interface DirectoryConfig {
  domain: string;
  servers: string[];
  port: number;
  baseDn: string;
  bindUsername: string;
  bindPassword: string;
  caCertPem: string;
  adminGroup: string;
  viewerGroup: string;
}

export interface DirectoryAccount {
  guid: string;
  dn: string;
  /** sAMAccountName, lowercased. */
  username: string;
  email: string;
  displayName: string | null;
  role: DirectoryRole;
}

export type DirectoryAuthResult =
  | { ok: true; account: DirectoryAccount }
  | { ok: false; reason: "not_found" | "bad_password" | "disabled" | "no_group" | "unavailable"; detail?: string };

const USER_ATTRIBUTES = ["objectGUID", "userPrincipalName", "mail", "sAMAccountName", "displayName", "userAccountControl"];

/** The enabled configuration, or null when directory sign-in is off or incomplete. */
export async function loadDirectoryConfig(opts: { evenIfDisabled?: boolean } = {}): Promise<DirectoryConfig | null> {
  const s = await prisma.directorySettings.findUnique({ where: { id: "default" } });
  if (!s || (!s.enabled && !opts.evenIfDisabled)) return null;
  if (s.servers.length === 0 || !s.bindUsername || !s.bindPasswordEnc) return null;
  return {
    domain: s.domain,
    servers: s.servers,
    port: s.port,
    baseDn: s.baseDn || baseDnForDomain(s.domain),
    bindUsername: s.bindUsername,
    bindPassword: decryptSecret(s.bindPasswordEnc),
    caCertPem: s.caCertPem,
    adminGroup: s.adminGroup,
    viewerGroup: s.viewerGroup,
  };
}

function newClient(cfg: DirectoryConfig, server: string): Client {
  return new Client({
    url: `ldaps://${server}:${cfg.port}`,
    connectTimeout: 5000,
    timeout: 8000,
    // Verified against the CA the admin supplied (or the system store), and
    // against the server name — never rejectUnauthorized: false. Passwords
    // cross this connection.
    tlsOptions: {
      ca: cfg.caCertPem.trim() ? [cfg.caCertPem] : undefined,
      // SNI takes a host name only; for a DC given by IP the certificate must name that IP.
      servername: isIP(server) ? undefined : server,
      minVersion: "TLSv1.2",
    },
  });
}

/** `svc-dsp` → `svc-dsp@corp.example`; a UPN or DN is used as given. */
function bindName(cfg: DirectoryConfig): string {
  const name = cfg.bindUsername.trim();
  if (name.includes("@") || looksLikeDn(name)) return name;
  if (name.includes("\\")) return `${name.split("\\").pop()}@${cfg.domain}`;
  return `${name}@${cfg.domain}`;
}

class ServiceBindError extends Error {}

/**
 * Runs `fn` with a client bound as the lookup account, trying each domain
 * controller in order. Only an unreachable server moves on to the next; a
 * rejected lookup password is a configuration error and is reported as such.
 */
async function withServiceBind<T>(cfg: DirectoryConfig, fn: (client: Client, server: string) => Promise<T>): Promise<T> {
  const failures: string[] = [];
  for (const server of cfg.servers) {
    const client = newClient(cfg, server);
    try {
      try {
        await client.bind(bindName(cfg), cfg.bindPassword);
      } catch (err) {
        if (err instanceof InvalidCredentialsError) throw new ServiceBindError(`the lookup account was rejected by ${server}`);
        throw err;
      }
      return await fn(client, server);
    } catch (err) {
      if (err instanceof ServiceBindError) throw err;
      failures.push(`${server}: ${(err as Error).message}`);
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
  throw new Error(`no domain controller answered — ${failures.join("; ")}`);
}

async function resolveGroupDn(client: Client, cfg: DirectoryConfig, value: string): Promise<string | null> {
  const name = value.trim();
  if (!name) return null;
  if (looksLikeDn(name)) return name;
  const { searchEntries } = await client.search(cfg.baseDn, { scope: "sub", filter: groupFilter(name), attributes: ["dn"], sizeLimit: 2 });
  return searchEntries.length === 1 ? searchEntries[0]!.dn : null;
}

async function inGroup(client: Client, userDn: string, groupDn: string | null): Promise<boolean> {
  if (!groupDn) return false;
  const { searchEntries } = await client.search(userDn, { scope: "base", filter: memberOfFilter(groupDn), attributes: ["dn"] });
  return searchEntries.length > 0;
}

async function roleOf(client: Client, cfg: DirectoryConfig, userDn: string): Promise<DirectoryRole | null> {
  const [adminDn, viewerDn] = await Promise.all([resolveGroupDn(client, cfg, cfg.adminGroup), resolveGroupDn(client, cfg, cfg.viewerGroup)]);
  return roleFor({ admin: await inGroup(client, userDn, adminDn), viewer: await inGroup(client, userDn, viewerDn) });
}

function text(entry: Entry, attribute: string): string | undefined {
  const value = entry[attribute];
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : Buffer.isBuffer(first) ? first.toString("utf8") : String(first);
}

function toAccount(entry: Entry, cfg: DirectoryConfig, role: DirectoryRole): DirectoryAccount {
  const guid = entry.objectGUID;
  return {
    guid: formatGuid(Buffer.isBuffer(guid) ? guid : Buffer.from(guid as unknown as string, "binary")),
    dn: entry.dn,
    username: (text(entry, "sAMAccountName") ?? "").toLowerCase(),
    email: directoryEmail(
      { userPrincipalName: text(entry, "userPrincipalName"), mail: text(entry, "mail"), sAMAccountName: text(entry, "sAMAccountName") },
      cfg.domain,
    ),
    displayName: text(entry, "displayName") ?? null,
    role,
  };
}

/** Checks a sign-in name and password against AD, and works out the role. */
export async function authenticateDirectory(cfg: DirectoryConfig, loginName: string, password: string): Promise<DirectoryAuthResult> {
  const login = parseLoginName(loginName);
  if (!login) return { ok: false, reason: "not_found" };
  if (!isUsablePassword(password)) return { ok: false, reason: "bad_password" };
  try {
    return await withServiceBind(cfg, async (client, server) => {
      const { searchEntries } = await client.search(cfg.baseDn, {
        scope: "sub",
        filter: userFilter(login),
        attributes: USER_ATTRIBUTES,
        explicitBufferAttributes: ["objectGUID"],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) return { ok: false as const, reason: "not_found" as const };
      const entry = searchEntries[0]!;
      if (isDisabled(text(entry, "userAccountControl"))) return { ok: false as const, reason: "disabled" as const };

      // The password check itself: bind as the person, on the same DC.
      const asUser = newClient(cfg, server);
      try {
        await asUser.bind(entry.dn, password);
      } catch (err) {
        if (err instanceof InvalidCredentialsError) return { ok: false as const, reason: "bad_password" as const };
        throw err;
      } finally {
        await asUser.unbind().catch(() => undefined);
      }

      const role = await roleOf(client, cfg, entry.dn);
      if (!role) return { ok: false as const, reason: "no_group" as const };
      return { ok: true as const, account: toAccount(entry, cfg, role) };
    });
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: (err as Error).message };
  }
}

export type DirectoryRecheck =
  | { state: "ok"; role: DirectoryRole; dn: string }
  | { state: "gone" | "disabled" | "no_group" }
  | { state: "unavailable"; detail: string };

/**
 * Is this account still enabled and in a mapped group? Found by objectGUID
 * (`<GUID=...>` as the search base), so renames and OU moves don't matter.
 */
export async function recheckDirectoryAccount(cfg: DirectoryConfig, guid: string): Promise<DirectoryRecheck> {
  try {
    return await withServiceBind(cfg, async (client) => {
      let entries: Entry[];
      try {
        ({ searchEntries: entries } = await client.search(`<GUID=${guid}>`, { scope: "base", attributes: ["userAccountControl"] }));
      } catch {
        entries = []; // no such object
      }
      const entry = entries[0];
      if (!entry) return { state: "gone" as const };
      if (isDisabled(text(entry, "userAccountControl"))) return { state: "disabled" as const };
      const role = await roleOf(client, cfg, entry.dn);
      return role ? { state: "ok" as const, role, dn: entry.dn } : { state: "no_group" as const };
    });
  } catch (err) {
    return { state: "unavailable", detail: (err as Error).message };
  }
}

export interface DirectoryTestStep {
  step: string;
  ok: boolean;
  detail: string;
}

/** For the settings page's Test button: each stage, so a failure says where. */
export async function testDirectory(cfg: DirectoryConfig, login?: { name: string; password: string }): Promise<DirectoryTestStep[]> {
  const steps: DirectoryTestStep[] = [];
  for (const server of cfg.servers) {
    const client = newClient(cfg, server);
    try {
      await client.bind(bindName(cfg), cfg.bindPassword);
      steps.push({ step: `${server}:${cfg.port}`, ok: true, detail: "TLS certificate trusted; lookup account signed in" });
    } catch (err) {
      steps.push({ step: `${server}:${cfg.port}`, ok: false, detail: (err as Error).message });
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
  if (!steps.some((s) => s.ok)) return steps;

  await withServiceBind(cfg, async (client) => {
    for (const [label, value] of [["Admin group", cfg.adminGroup], ["Viewer group", cfg.viewerGroup]] as const) {
      if (!value.trim()) {
        steps.push({ step: label, ok: label === "Viewer group", detail: "not set" });
        continue;
      }
      const dn = await resolveGroupDn(client, cfg, value);
      steps.push({ step: label, ok: Boolean(dn), detail: dn ?? `no single group named "${value}" under ${cfg.baseDn}` });
    }
  }).catch((err) => steps.push({ step: "Groups", ok: false, detail: (err as Error).message }));

  if (login) {
    const result = await authenticateDirectory(cfg, login.name, login.password);
    const reasons: Record<string, string> = {
      not_found: "no such account under the base DN",
      bad_password: "AD rejected the password",
      disabled: "the account is disabled in AD",
      no_group: "the account is in neither group, so it can't sign in",
      unavailable: "no domain controller answered",
    };
    steps.push(
      result.ok
        ? { step: `Sign-in as ${login.name}`, ok: true, detail: `${result.account.email} → ${result.account.role}` }
        : { step: `Sign-in as ${login.name}`, ok: false, detail: reasons[result.reason] + (result.detail ? ` (${result.detail})` : "") },
    );
  }
  return steps;
}
