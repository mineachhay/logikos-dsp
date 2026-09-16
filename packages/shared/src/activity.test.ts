import { describe, expect, it } from "vitest";
import {
  accessListToAction,
  activityPathForSource,
  activityWindowFor,
  matchActivity,
  parseSecurityEvent,
  shareNameFromEvent,
  type ActivityCandidate,
} from "./activity.js";

/** Shaped like PowerShell's .ToXml() for a 5145, with the fields Windows actually writes. */
function event5145(overrides: Partial<Record<string, string>> = {}): string {
  const d: Record<string, string> = {
    SubjectUserSid: "S-1-5-21-1234-1111",
    SubjectUserName: "jdoe",
    SubjectDomainName: "CORP",
    SubjectLogonId: "0x3e7",
    ObjectType: "File",
    IpAddress: "10.0.0.42",
    IpPort: "51234",
    ShareName: "\\\\*\\finance",
    ShareLocalPath: "\\??\\D:\\shares\\finance",
    RelativeTargetName: "exports\\q1\\payroll.csv",
    AccessMask: "0x2",
    AccessList: "%%4417\r\n\t\t\t\t",
    ...overrides,
  };
  return `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing'/><EventID>5145</EventID><TimeCreated SystemTime='2026-09-16T14:01:42.1234567Z'/><EventRecordID>987654</EventRecordID></System><EventData>${Object.entries(
    d,
  )
    .map(([k, v]) => `<Data Name='${k}'>${v}</Data>`)
    .join("")}</EventData></Event>`;
}

describe("parseSecurityEvent", () => {
  it("pulls who, where and what from a 5145", () => {
    expect(parseSecurityEvent(event5145())).toEqual({
      recordId: 987654,
      occurredAt: "2026-09-16T14:01:42.123Z",
      userName: "jdoe",
      userDomain: "CORP",
      clientIp: "10.0.0.42",
      shareName: "\\\\*\\finance",
      relativeTarget: "exports\\q1\\payroll.csv",
      action: "WRITE",
    });
  });

  it("ignores other event ids, directory-level accesses and Windows' '-' placeholders", () => {
    expect(parseSecurityEvent(event5145().replace("5145", "4624"))).toBeNull();
    expect(parseSecurityEvent(event5145({ RelativeTargetName: "-" }))).toBeNull();
    expect(parseSecurityEvent(event5145({ RelativeTargetName: "\\" }))).toBeNull();
    const noIp = parseSecurityEvent(event5145({ IpAddress: "-", SubjectDomainName: "-" }))!;
    expect(noIp.clientIp).toBeUndefined();
    expect(noIp.userDomain).toBeUndefined();
  });

  it("skips the server's own machine account — that's not a person", () => {
    expect(parseSecurityEvent(event5145({ SubjectUserName: "WIN-FS$" }))).toBeNull();
  });
});

describe("accessListToAction", () => {
  it("reads Windows' %%codes, with delete outranking a write requested alongside it", () => {
    expect(accessListToAction("%%4417")).toBe("WRITE");
    expect(accessListToAction("%%1537")).toBe("DELETE");
    expect(accessListToAction("%%4417\r\n\t%%1537")).toBe("DELETE");
    expect(accessListToAction("%%4416")).toBe("READ");
    expect(accessListToAction("%%4423")).toBe("READ");
    expect(accessListToAction("")).toBe("OTHER");
  });
});

describe("activityPathForSource", () => {
  const event = { shareName: "\\\\*\\finance", relativeTarget: "exports\\q1\\payroll.csv" };

  it("maps a share path onto the source's own paths", () => {
    expect(shareNameFromEvent("\\\\*\\finance")).toBe("finance");
    expect(activityPathForSource(event, { shareName: "finance", subPath: "" })).toBe("exports/q1/payroll.csv");
    expect(activityPathForSource(event, { shareName: "FINANCE", subPath: "exports" })).toBe("q1/payroll.csv");
  });

  it("returns null for another share, or a folder outside this source", () => {
    expect(activityPathForSource(event, { shareName: "hr", subPath: "" })).toBeNull();
    expect(activityPathForSource(event, { shareName: "finance", subPath: "archive" })).toBeNull();
  });
});

describe("matchActivity", () => {
  const scanAt = new Date("2026-09-16T14:02:00Z");
  const candidate = (over: Partial<ActivityCandidate>): ActivityCandidate => ({
    id: "a1",
    path: "q1/payroll.csv",
    action: "WRITE",
    occurredAt: new Date("2026-09-16T14:01:42Z"),
    userName: "jdoe",
    ...over,
  });

  it("matches the write behind a scan-detected change", () => {
    const match = matchActivity(
      { path: "q1/payroll.csv", eventType: "CREATED", occurredAt: scanAt },
      [candidate({})],
      activityWindowFor(60),
    );
    expect(match?.userName).toBe("jdoe");
  });

  it("prefers the most recent compatible record", () => {
    const older = candidate({ id: "old", userName: "alice", occurredAt: new Date("2026-09-16T14:00:10Z") });
    const newer = candidate({ id: "new", userName: "bob", occurredAt: new Date("2026-09-16T14:01:50Z") });
    const match = matchActivity({ path: "q1/payroll.csv", eventType: "MODIFIED", occurredAt: scanAt }, [older, newer], activityWindowFor(60));
    expect(match?.id).toBe("new");
  });

  it("won't pass off a read as the cause of a change, or a write as a delete", () => {
    const reads = [candidate({ action: "READ" })];
    expect(matchActivity({ path: "q1/payroll.csv", eventType: "MODIFIED", occurredAt: scanAt }, reads, activityWindowFor(60))).toBeNull();
    expect(matchActivity({ path: "q1/payroll.csv", eventType: "DELETED", occurredAt: scanAt }, [candidate({})], activityWindowFor(60))).toBeNull();
    expect(matchActivity({ path: "q1/payroll.csv", eventType: "DELETED", occurredAt: scanAt }, [candidate({ action: "DELETE" })], activityWindowFor(60))?.userName).toBe("jdoe");
  });

  it("ignores a different file, and anything outside the window", () => {
    const other = candidate({ path: "q1/other.csv" });
    expect(matchActivity({ path: "q1/payroll.csv", eventType: "CREATED", occurredAt: scanAt }, [other], activityWindowFor(60))).toBeNull();
    const tooOld = candidate({ occurredAt: new Date("2026-09-16T13:55:00Z") });
    expect(matchActivity({ path: "q1/payroll.csv", eventType: "CREATED", occurredAt: scanAt }, [tooOld], activityWindowFor(60))).toBeNull();
  });

  it("looks back one scan interval plus slack, so a slow schedule still matches", () => {
    expect(activityWindowFor(3600).beforeMs).toBe(3_720_000);
    const longAgo = candidate({ occurredAt: new Date("2026-09-16T13:10:00Z") });
    expect(matchActivity({ path: "q1/payroll.csv", eventType: "CREATED", occurredAt: scanAt }, [longAgo], activityWindowFor(3600))?.userName).toBe("jdoe");
  });
});
