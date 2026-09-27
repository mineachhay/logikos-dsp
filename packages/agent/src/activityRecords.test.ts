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
  it("continues right after the last event when the result was capped, so none is skipped", () => {
    expect(nextBookmark({ after: 100, windowEnd: 50_100, recordIds: [101, 140, 900], newestRecordId: 90_000, maxEvents: 3 })).toBe(900);
  });

  it("moves to the end of the range once it's been read in full", () => {
    // A busy server: most record IDs are other Security events, so a range
    // holding only two 5145s is still read to its end, not stopped at 140.
    expect(nextBookmark({ after: 100, windowEnd: 50_100, recordIds: [101, 140], newestRecordId: 90_000, maxEvents: 500 })).toBe(50_100);
    expect(nextBookmark({ after: 100, windowEnd: 50_100, recordIds: [], newestRecordId: 90_000, maxEvents: 500 })).toBe(50_100);
  });

  it("never moves past the newest record — later IDs are events not written yet", () => {
    expect(nextBookmark({ after: 100, windowEnd: 50_100, recordIds: [], newestRecordId: 320, maxEvents: 500 })).toBe(320);
    expect(nextBookmark({ after: 100, windowEnd: 50_100, recordIds: [330], newestRecordId: 320, maxEvents: 500 })).toBe(330);
  });

  it("jumps over record numbers the circular log no longer holds", () => {
    expect(nextBookmark({ after: 7_000_000, windowEnd: 7_050_000, recordIds: [], newestRecordId: 26_010_000_000, oldestRecordId: 26_000_000_001, maxEvents: 500 })).toBe(
      26_000_000_000,
    );
    // …but never backwards, and not past events it was handed.
    expect(nextBookmark({ after: 900, windowEnd: 50_900, recordIds: [], newestRecordId: 90_000, oldestRecordId: 10, maxEvents: 500 })).toBe(50_900);
  });

  it("stays put when it knows nothing about the log", () => {
    expect(nextBookmark({ after: 100, windowEnd: 50_100, recordIds: [], newestRecordId: null, maxEvents: 500 })).toBe(100);
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

describe("folder listings versus file reads", () => {
  const withFiles = [{ ...shares[0], knownFiles: new Set(["q1/payroll.csv"]) }];

  it("keeps a read of a file the last scan saw", () => {
    const read = event5145({ AccessList: "%%4416" }, 40);
    expect(buildActivityRecords([read], withFiles, { recordReads: true }).records.map((r) => r.path)).toEqual(["q1/payroll.csv"]);
  });

  it("drops a read of a folder — Windows logs listing one exactly like reading a file", () => {
    const listing = event5145({ AccessList: "%%4416", RelativeTargetName: "exports\\q1" }, 41);
    const built = buildActivityRecords([listing], withFiles, { recordReads: true });
    expect(built.records).toEqual([]);
    expect(built.ignored).toBe(1);
  });

  it("still records writes and deletes of paths the scan hasn't seen yet — a brand new file", () => {
    const write = event5145({ AccessList: "%%4417", RelativeTargetName: "exports\\q1\\brand new.csv" }, 42);
    expect(buildActivityRecords([write], withFiles, { recordReads: true }).records.map((r) => r.action)).toEqual(["WRITE"]);
  });
});
