// Pure rules for signing in with Active Directory accounts — no network, so
// they're unit tested. The LDAP I/O lives in directoryClient.ts.
import { AndFilter, EqualityFilter, ExtensibleFilter, OrFilter } from "ldapts";
import type { Filter } from "ldapts";

export type DirectoryRole = "ADMIN" | "VIEWER";

/**
 * What someone typed as their sign-in name, reduced to what AD can look up.
 * Accepts `jdoe`, `CORP\jdoe` and `jdoe@corp.example`. The NetBIOS prefix is
 * dropped rather than checked: it's a single-domain setup, and the account is
 * then confirmed by AD itself when the password is checked.
 */
export function parseLoginName(input: string): { sam: string; upn: string | null } | null {
  const name = input.trim();
  if (!name || name.length > 256) return null;
  if (name.includes("\\")) {
    const sam = name.split("\\").pop()!.trim();
    return sam ? { sam, upn: null } : null;
  }
  if (name.includes("@")) {
    const [local, domain] = name.split("@");
    if (!local || !domain) return null;
    return { sam: local, upn: name };
  }
  return { sam: name, upn: null };
}

/**
 * The search for one person's account. Built from ldapts filter objects, which
 * escape their values — the text typed at the login box can't add conditions
 * to the search (LDAP injection), as it could with a string-built filter.
 */
export function userFilter(login: { sam: string; upn: string | null }): Filter {
  const names: Filter[] = [new EqualityFilter({ attribute: "sAMAccountName", value: login.sam })];
  if (login.upn) names.push(new EqualityFilter({ attribute: "userPrincipalName", value: login.upn }));
  return new AndFilter({
    filters: [
      new EqualityFilter({ attribute: "objectCategory", value: "person" }),
      new EqualityFilter({ attribute: "objectClass", value: "user" }),
      names.length === 1 ? names[0]! : new OrFilter({ filters: names }),
    ],
  });
}

/** `member of this group, directly or through nested groups` (AD's LDAP_MATCHING_RULE_IN_CHAIN). */
export const IN_CHAIN_RULE = "1.2.840.113556.1.4.1941";

export function memberOfFilter(groupDn: string): Filter {
  return new ExtensibleFilter({ matchType: "memberOf", rule: IN_CHAIN_RULE, value: groupDn });
}

/** A group given by name (`DSP-Admins`) rather than DN is looked up by these. */
export function groupFilter(name: string): Filter {
  return new AndFilter({
    filters: [
      new EqualityFilter({ attribute: "objectClass", value: "group" }),
      new OrFilter({
        filters: [new EqualityFilter({ attribute: "sAMAccountName", value: name }), new EqualityFilter({ attribute: "cn", value: name })],
      }),
    ],
  });
}

export function looksLikeDn(value: string): boolean {
  return /^\s*[a-z]+=/i.test(value);
}

/** corp.example → DC=corp,DC=example */
export function baseDnForDomain(domain: string): string {
  return domain
    .trim()
    .replace(/\.$/, "")
    .split(".")
    .filter(Boolean)
    .map((part) => `DC=${part}`)
    .join(",");
}

/** userAccountControl bit 0x2: ACCOUNTDISABLE. */
export function isDisabled(userAccountControl: string | number | undefined): boolean {
  const value = Number(userAccountControl ?? 0);
  return Number.isFinite(value) && (value & 0x2) !== 0;
}

/** Admin group wins when someone is in both. Null: in neither, so no access. */
export function roleFor(memberOf: { admin: boolean; viewer: boolean }): DirectoryRole | null {
  if (memberOf.admin) return "ADMIN";
  if (memberOf.viewer) return "VIEWER";
  return null;
}

/**
 * A simple bind with an empty password is an *anonymous* bind, which AD
 * answers with success — so "bind as the user to check their password" would
 * let anyone in with a blank password. Refuse before it reaches LDAP.
 */
export function isUsablePassword(password: string): boolean {
  return password.length > 0;
}

/** AD's objectGUID bytes as the usual 8-4-4-4-12 string (first three groups little-endian). */
export function formatGuid(bytes: Buffer): string {
  if (bytes.length !== 16) throw new Error(`objectGUID must be 16 bytes, got ${bytes.length}`);
  const hex = (b: Buffer) => b.toString("hex");
  const le = (start: number, len: number) => hex(Buffer.from(bytes.subarray(start, start + len)).reverse());
  return `${le(0, 4)}-${le(4, 2)}-${le(6, 2)}-${hex(bytes.subarray(8, 10))}-${hex(bytes.subarray(10, 16))}`;
}

/** The address a directory user is known by here: their UPN (unique in the forest), lowercased. */
export function directoryEmail(entry: { userPrincipalName?: string; mail?: string; sAMAccountName?: string }, domain: string): string {
  const upn = entry.userPrincipalName || (entry.sAMAccountName ? `${entry.sAMAccountName}@${domain}` : "");
  return upn.trim().toLowerCase();
}
