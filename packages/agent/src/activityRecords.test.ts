import { describe, expect, it } from "vitest";
import { buildActivityRecords, describeActivityError, initialBookmark, nextBookmark } from "./activityRecords.js";

function event5145(over: Partial<Record<string, string>> = {}, recordId = 1): string {
  const d: Record<string, string> = {
    SubjectUserName: "jdoe",
    SubjectDomainName: "CORP",
    IpAddress: "10.0.0.42",
    ShareName: "\\\\*\\finance",
    RelativeTargetName: "exports\\q1\\payroll.csv",
    AccessList: "%%4417",
    ...over,
  };
  return `<Event><System><EventID>5145</EventID><TimeCreated SystemTime='2026-09-16T14:01:42.0000000Z'/><EventRecordID>${recordId}</EventRecordID></System><EventData>${Object.entries(
    d,
  )
    .map(([k, v]) => `<Data Name='${k}'>${v}</Data>`)
    .join("")}</EventData></Event>`;
}

const shares = [{ sourceId: "src-fin", shareName: "finance", subPath: "exports" }];

describe("buildActivityRecords", () => {
  it("keeps changes to monitored shares, mapped to the source's own paths", () => {
    const built = buildActivityRecords([event5145({}, 10)], shares);
    expect(built.records).toEqual([
      {
        sourceId: "src-fin",
        path: "q1/payroll.csv",
        action: "WRITE",
        userName: "jdoe",
        userDomain: "CORP",
        clientIp: "10.0.0.42",
        occurredAt: "2026-09-16T14:01:42.000Z",
        recordId: 10,
      },
    ]);
    expect(built.recordIds).toEqual([10]);
  });

  it("drops reads, other shares and folders outside the source, but still counts them as read", () => {
    const built = buildActivityRecords(
      [
        event5145({ AccessList: "%%4416" }, 11),
        event5145({ ShareName: "\\\\*\\hr" }, 12),
        event5145({ RelativeTargetName: "archive\\old.csv" }, 13),
        event5145({ AccessList: "%%1537" }, 14),
      ],
      shares,
    );
    expect(built.records.map((r) => r.recordId)).toEqual([14]);
    expect(built.records[0].action).toBe("DELETE");
    expect(built.ignored).toBe(3);
    // Every parsed record still advances the bookmark, or ignored events would be re-read forever.
    expect(built.recordIds).toEqual([11, 12, 13, 14]);
  });
});

describe("buildActivityRecords with read recording", () => {
  it("keeps reads when the file server asks for them — the only trace of a copy off the share", () => {
    const read = event5145({ AccessList: "%%4416" }, 20);
    expect(buildActivityRecords([read], shares).records).toEqual([]);
    const withReads = buildActivityRecords([read], shares, { recordReads: true });
    expect(withReads.records.map((r) => r.action)).toEqual(["READ"]);
    expect(withReads.records[0].path).toBe("q1/payroll.csv");
  });

  it("still drops reads of other shares and unreadable events", () => {
    const otherShare = event5145({ AccessList: "%%4416", ShareName: "\\\\*\\hr" }, 21);
    expect(buildActivityRecords([otherShare], shares, { recordReads: true }).records).toEqual([]);
  });
});

describe("nextBookmark", () => {
  it("continues from the highest record read", () => {
    expect(nextBookmark({ after: 100, windowEnd: 600, recordIds: [101, 140], newestRecordId: 900 })).toBe(140);
  });

  it("skips an empty window the log has already moved past, instead of stalling", () => {
    expect(nextBookmark({ after: 100, windowEnd: 600, recordIds: [], newestRecordId: 5000 })).toBe(600);
  });

  it("stays put when the window is empty because nothing new has happened", () => {
    expect(nextBookmark({ after: 100, windowEnd: 600, recordIds: [], newestRecordId: 320 })).toBe(100);
    expect(nextBookmark({ after: 100, windowEnd: 600, recordIds: [], newestRecordId: null })).toBe(100);
  });
});

describe("initialBookmark", () => {
  it("starts just behind the newest record, not at the beginning of the log", () => {
    expect(initialBookmark(500_000)).toBe(499_800);
    expect(initialBookmark(50)).toBe(0);
    expect(initialBookmark(null)).toBe(0);
  });
});

describe("describeActivityError", () => {
  it("explains the failures a real Windows server produced", () => {
    expect(describeActivityError("ValueError: unsupported hash type md4", "fs01", 5985)).toMatch(/rebuild the agent image/);
    expect(describeActivityError("InvalidCredentialsError: the specified credentials were rejected by the server", "fs01", 5985)).toMatch(
      /Remote Management Users/,
    );
    expect(describeActivityError("ConnectionError: HTTPConnectionPool(host='fs01', port=5985): Max retries exceeded", "fs01", 5985)).toMatch(
      /can't reach WinRM at fs01:5985/,
    );
    expect(describeActivityError("Could not retrieve information about the Security log. Error: Attempted to perform an unauthorized operation.", "fs01", 5985)).toMatch(
      /wevtutil sl Security/,
    );
  });

  it("passes through anything it doesn't recognize, trimmed", () => {
    expect(describeActivityError("SomeNewError:  weird\n  thing", "fs01", 5985)).toBe("SomeNewError: weird thing");
  });
});

describe("the agent's own access", () => {
  it("ignores the account the agent scans with — that's us reading the share, not a person", () => {
    const ours = event5145({ SubjectUserName: "dsp", AccessList: "%%4416" }, 30);
    const theirs = event5145({ SubjectUserName: "jdoe", AccessList: "%%4416" }, 31);
    const built = buildActivityRecords([ours, theirs], shares, { recordReads: true, scanAccount: "dsp" });
    expect(built.records.map((r) => r.userName)).toEqual(["jdoe"]);
    expect(built.ignored).toBe(1);
    // Both still advance the bookmark, or the ignored one is re-read forever.
    expect(built.recordIds).toEqual([30, 31]);
  });

  it("matches the scan account regardless of a domain prefix", () => {
    const ours = event5145({ SubjectUserName: "dsp" }, 32);
    expect(buildActivityRecords([ours], shares, { scanAccount: "CORP\\dsp" }).records).toEqual([]);
  });
});
