import { describe, expect, it } from "vitest";
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

describe("parseLoginName", () => {
  it("accepts a bare name, DOMAIN\\name and a UPN", () => {
    expect(parseLoginName("jdoe")).toEqual({ sam: "jdoe", upn: null });
    expect(parseLoginName(" CORP\\jdoe ")).toEqual({ sam: "jdoe", upn: null });
    expect(parseLoginName("jdoe@corp.example")).toEqual({ sam: "jdoe", upn: "jdoe@corp.example" });
  });

  it("rejects what can't be a name", () => {
    expect(parseLoginName("")).toBeNull();
    expect(parseLoginName("CORP\\")).toBeNull();
    expect(parseLoginName("@corp.example")).toBeNull();
    expect(parseLoginName("x".repeat(300))).toBeNull();
  });
});

describe("filters", () => {
  it("escapes what was typed, so it can't add conditions to the search", () => {
    const filter = userFilter({ sam: "*)(sAMAccountName=*", upn: null }).toString();
    expect(filter).toContain("(sAMAccountName=\\2a\\29\\28sAMAccountName=\\2a)");
    expect(filter).not.toContain("(sAMAccountName=*)");
  });

  it("looks a UPN up by either attribute, only among people", () => {
    const filter = userFilter({ sam: "jdoe", upn: "jdoe@corp.example" }).toString();
    expect(filter).toBe("(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=jdoe)(userPrincipalName=jdoe@corp.example)))");
  });

  it("checks nested membership with AD's in-chain rule", () => {
    expect(memberOfFilter("CN=DSP-Admins,DC=corp,DC=example").toString()).toBe(
      "(memberOf:1.2.840.113556.1.4.1941:=CN=DSP-Admins,DC=corp,DC=example)",
    );
    expect(groupFilter("DSP-Admins").toString()).toBe("(&(objectClass=group)(|(sAMAccountName=DSP-Admins)(cn=DSP-Admins)))");
  });
});

describe("account rules", () => {
  it("reads the disabled bit of userAccountControl", () => {
    expect(isDisabled("512")).toBe(false); // NORMAL_ACCOUNT
    expect(isDisabled("514")).toBe(true); // NORMAL_ACCOUNT | ACCOUNTDISABLE
    expect(isDisabled(66050)).toBe(true); // … | DONT_EXPIRE_PASSWORD
    expect(isDisabled(undefined)).toBe(false);
  });

  it("gives admin precedence and nothing to someone in neither group", () => {
    expect(roleFor({ admin: true, viewer: true })).toBe("ADMIN");
    expect(roleFor({ admin: false, viewer: true })).toBe("VIEWER");
    expect(roleFor({ admin: false, viewer: false })).toBeNull();
  });

  it("refuses an empty password, which LDAP would treat as an anonymous bind", () => {
    expect(isUsablePassword("")).toBe(false);
    expect(isUsablePassword(" ")).toBe(true);
  });

  it("formats objectGUID with the first three groups little-endian", () => {
    const bytes = Buffer.from("76cea3104b63584 3a4888b8ff001ef49".replace(/ /g, ""), "hex");
    expect(formatGuid(bytes)).toBe("10a3ce76-634b-4358-a488-8b8ff001ef49");
    expect(() => formatGuid(Buffer.alloc(4))).toThrow();
  });

  it("derives the base DN and the address a directory user is known by", () => {
    expect(baseDnForDomain("corp.example")).toBe("DC=corp,DC=example");
    expect(looksLikeDn("CN=x,DC=y")).toBe(true);
    expect(looksLikeDn("DSP-Admins")).toBe(false);
    expect(directoryEmail({ userPrincipalName: "JDoe@Corp.Example" }, "corp.example")).toBe("jdoe@corp.example");
    expect(directoryEmail({ sAMAccountName: "jdoe" }, "corp.example")).toBe("jdoe@corp.example");
  });
});
