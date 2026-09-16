import { describe, expect, it } from "vitest";
import { buildActivityRecords, initialBookmark, nextBookmark } from "./activityRecords.js";

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
