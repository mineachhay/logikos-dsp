import { describe, expect, it } from "vitest";
import {
  accessListToAction,
  inferCopySourceFromReads,
  inferCrossSourceCopy,
  inferRenameFromAudit,
  activityPathForSource,
  activityWindowFor,
  matchActivity,
  parseSecurityEvent,
  shareNameFromEvent,
  type ActivityCandidate,
  type CrossSourceRead,
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

  it("matches a rename by the old name, which is where Windows logs the delete right", () => {
    const deleteOnOldName = candidate({ path: "q1/old-name.csv", action: "DELETE", userName: "jdoe" });
    const match = matchActivity(
      { path: "q1/new-name.csv", previousPath: "q1/old-name.csv", eventType: "RENAMED", occurredAt: scanAt },
      [deleteOnOldName],
      activityWindowFor(60),
    );
    expect(match?.userName).toBe("jdoe");
  });

  it("still matches a rename by the new name when the server logged a write there", () => {
    const writeOnNewName = candidate({ path: "q1/new-name.csv", action: "WRITE", userName: "bob" });
    const match = matchActivity(
      { path: "q1/new-name.csv", previousPath: "q1/old-name.csv", eventType: "RENAMED", occurredAt: scanAt },
      [writeOnNewName],
      activityWindowFor(60),
    );
    expect(match?.userName).toBe("bob");
  });

  it("doesn't let a delete of the old name explain a plain delete of another file", () => {
    const deleteElsewhere = candidate({ path: "q1/old-name.csv", action: "DELETE" });
    expect(
      matchActivity({ path: "q1/new-name.csv", eventType: "DELETED", occurredAt: scanAt }, [deleteElsewhere], activityWindowFor(60)),
    ).toBeNull();
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

describe("inferRenameFromAudit", () => {
  const scanAt = new Date("2026-09-16T09:13:54Z");
  const window = activityWindowFor(60);
  const del = (path: string, secondsBefore: number, userName = "Administrator"): ActivityCandidate => ({
    id: `d-${path}`,
    path,
    action: "DELETE",
    occurredAt: new Date(scanAt.getTime() - secondsBefore * 1000),
    userName,
  });

  it("recognizes a rename that happened between two scans", () => {
    // The file was created and renamed inside one scan interval, so only the
    // new name was ever seen — and only the old name was ever logged.
    const match = inferRenameFromAudit({ path: "HR/rename file.txt", occurredAt: scanAt }, [del("HR/rename dsp file updated.txt", 20)], [], window);
    expect(match?.path).toBe("HR/rename dsp file updated.txt");
    expect(match?.userName).toBe("Administrator");
  });

  it("ignores a delete that the scan already reported as a deletion", () => {
    const record = del("HR/really deleted.txt", 20);
    expect(inferRenameFromAudit({ path: "HR/new.txt", occurredAt: scanAt }, [record], ["HR/really deleted.txt"], window)).toBeNull();
  });

  it("won't guess when two files disappeared in the same window", () => {
    const records = [del("HR/one.txt", 20), del("HR/two.txt", 25)];
    expect(inferRenameFromAudit({ path: "HR/new.txt", occurredAt: scanAt }, records, [], window)).toBeNull();
  });

  it("ignores deletes outside the window, and a delete of the created path itself", () => {
    expect(inferRenameFromAudit({ path: "HR/new.txt", occurredAt: scanAt }, [del("HR/old.txt", 9999)], [], window)).toBeNull();
    expect(inferRenameFromAudit({ path: "HR/new.txt", occurredAt: scanAt }, [del("HR/new.txt", 20)], [], window)).toBeNull();
  });
});

describe("inferCopySourceFromReads", () => {
  const copiedAt = new Date("2026-09-16T10:18:40Z");
  const window = activityWindowFor(60);
  const read = (path: string, secondsBefore: number): ActivityCandidate => ({
    id: `r-${path}`,
    path,
    action: "READ",
    occurredAt: new Date(copiedAt.getTime() - secondsBefore * 1000),
    userName: "Administrator",
  });

  it("names the file a copy was read from, which size and name alone can't settle", () => {
    const match = inferCopySourceFromReads({ path: "FN/create file.zip", occurredAt: copiedAt }, [read("IT/create file.zip", 30)], window);
    expect(match?.path).toBe("IT/create file.zip");
  });

  it("stays silent when identical files were read from two places", () => {
    const reads = [read("IT/create file.zip", 30), read("create file.zip", 28)];
    expect(inferCopySourceFromReads({ path: "FN/create file.zip", occurredAt: copiedAt }, reads, window)).toBeNull();
  });

  it("ignores reads of other files, the copy itself, and reads outside the window", () => {
    expect(inferCopySourceFromReads({ path: "FN/create file.zip", occurredAt: copiedAt }, [read("IT/other.zip", 30)], window)).toBeNull();
    expect(inferCopySourceFromReads({ path: "FN/create file.zip", occurredAt: copiedAt }, [read("FN/create file.zip", 30)], window)).toBeNull();
    expect(inferCopySourceFromReads({ path: "FN/create file.zip", occurredAt: copiedAt }, [read("IT/create file.zip", 99_999)], window)).toBeNull();
  });
});

describe("inferCrossSourceCopy", () => {
  const arrivedAt = new Date("2026-09-17T06:30:00Z");
  const window = activityWindowFor(60);
  const read = (sourceId: string, path: string, secondsBefore: number, userName = "Administrator") => ({
    id: `r-${sourceId}-${path}`,
    sourceId,
    path,
    action: "READ" as const,
    occurredAt: new Date(arrivedAt.getTime() - secondsBefore * 1000),
    userName,
  });

  it("joins a file arriving on one machine to it being read from another", () => {
    const match = inferCrossSourceCopy(
      { path: "payroll.csv", occurredAt: arrivedAt, sourceId: "laptop-downloads" },
      [read("finance-share", "HR/payroll.csv", 20)],
      window,
    );
    expect(match?.read.path).toBe("HR/payroll.csv");
    expect(match?.read.sourceId).toBe("finance-share");
    expect(match?.actorCertain).toBe(true);
  });

  it("ignores reads on the same source — that's a copy within one share, handled by the scan", () => {
    expect(
      inferCrossSourceCopy(
        { path: "payroll.csv", occurredAt: arrivedAt, sourceId: "finance-share" },
        [read("finance-share", "HR/payroll.csv", 20)],
        window,
      ),
    ).toBeNull();
  });

  it("stays silent when the same filename was read from two different places", () => {
    const reads = [read("finance-share", "HR/payroll.csv", 20), read("hr-share", "payroll.csv", 22)];
    expect(inferCrossSourceCopy({ path: "payroll.csv", occurredAt: arrivedAt, sourceId: "laptop" }, reads, window)).toBeNull();
  });

  it("ignores a different filename, or a read too long before", () => {
    expect(
      inferCrossSourceCopy({ path: "payroll.csv", occurredAt: arrivedAt, sourceId: "laptop" }, [read("share", "other.csv", 20)], window),
    ).toBeNull();
    expect(
      inferCrossSourceCopy({ path: "payroll.csv", occurredAt: arrivedAt, sourceId: "laptop" }, [read("share", "payroll.csv", 99_999)], window),
    ).toBeNull();
  });
});

describe("inferCrossSourceCopy with repeated filenames", () => {
  const window = { beforeMs: 300_000, afterMs: 30_000 };
  const at = new Date("2026-09-17T07:45:39Z");
  const read = (path: string, sourceId = "share"): CrossSourceRead => ({
    id: `r-${path}`,
    path,
    action: "READ",
    occurredAt: new Date("2026-09-17T07:45:38Z"),
    userName: "Administrator",
    userDomain: null,
    clientIp: null,
    sourceId,
  });

  // The case that made a real 12-file copy attribute nothing: the same
  // filename lives in several folders of the share, and copying the tree
  // reads every one of them.
  it("uses the folder structure a copy preserves", () => {
    const reads = [
      read("New Compressed (zipped) Folder.zip"),
      read("IT/New Compressed (zipped) Folder.zip"),
      read("HR/New Compressed (zipped) Folder.zip"),
      read("New folder/New Compressed (zipped) Folder.zip"),
    ];
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\Administrator\\Downloads\\IT\\New Compressed (zipped) Folder.zip", occurredAt: at, sourceId: "laptop" },
      reads,
      window,
    );
    expect(match?.read.path).toBe("IT/New Compressed (zipped) Folder.zip");
  });

  it("matches a file copied from the share root, not one of its folders", () => {
    const reads = [
      read("New Compressed (zipped) Folder.zip"),
      read("IT/New Compressed (zipped) Folder.zip"),
      read("HR/New Compressed (zipped) Folder.zip"),
    ];
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\Administrator\\Downloads\\New Compressed (zipped) Folder.zip", occurredAt: at, sourceId: "laptop" },
      reads,
      window,
    );
    expect(match?.read.path).toBe("New Compressed (zipped) Folder.zip");
  });

  // Copying one file out of a folder into the root of the watched path: the
  // structure isn't preserved, so the filename is all there is — and that's
  // enough when only one file has it.
  it("falls back to the filename when the structure wasn't kept", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\Administrator\\Downloads\\payroll.csv", occurredAt: at, sourceId: "laptop" },
      [read("HR/payroll.csv")],
      window,
    );
    expect(match?.read.path).toBe("HR/payroll.csv");
  });

  it("still refuses when two identical names sit at the same depth", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\Administrator\\Downloads\\report.zip", occurredAt: at, sourceId: "laptop" },
      [read("HR/report.zip"), read("IT/report.zip")],
      window,
    );
    expect(match).toBeNull();
  });

  it("works without a root, treating the whole path as relative", () => {
    const match = inferCrossSourceCopy(
      { path: "IT/report.zip", occurredAt: at, sourceId: "other-share" },
      [read("IT/report.zip")],
      window,
    );
    expect(match?.read.path).toBe("IT/report.zip");
  });
});

describe("inferCrossSourceCopy never guesses which share", () => {
  const window = { beforeMs: 300_000, afterMs: 30_000 };
  const at = new Date("2026-09-17T07:45:39Z");
  const read = (path: string, sourceId: string): CrossSourceRead => ({
    id: `r-${sourceId}-${path}`,
    path,
    action: "READ",
    occurredAt: new Date("2026-09-17T07:45:38Z"),
    userName: "Administrator",
    userDomain: null,
    clientIp: null,
    sourceId,
  });

  // Structure says which file within a share was copied. It says nothing
  // about which share, so an exact structural match on one server must not
  // outvote a plainer match on another — naming the wrong server is worse
  // than naming none.
  it("refuses even when one candidate matches the folder structure exactly", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\jdoe\\Downloads\\payroll.csv", occurredAt: at, sourceId: "laptop" },
      [read("payroll.csv", "hr-share"), read("HR/payroll.csv", "finance-share")],
      window,
    );
    expect(match).toBeNull();
  });
});

// Found on a live machine: an agent watching several drives is identified by
// its hostname, not a path, so the destination's root can't be stripped. The
// share's own root-level files then looked no better than the copies of the
// same name inside its folders, and exactly those fell back to CREATED while
// everything in a subfolder resolved.
describe("inferCrossSourceCopy with an unknown destination root", () => {
  const window = { beforeMs: 300_000, afterMs: 30_000 };
  const at = new Date("2026-09-18T09:13:55Z");
  const read = (path: string): CrossSourceRead => ({
    id: `r-${path}`,
    path,
    action: "READ",
    occurredAt: new Date("2026-09-18T09:13:54Z"),
    userName: "Administrator",
    userDomain: null,
    clientIp: null,
    sourceId: "share",
  });

  const reads = [
    read("create file.zip"),
    read("FN/create file.zip"),
    read("HR/create file.zip"),
    read("IT/create file.zip"),
  ];

  it("matches a file from the share root, copied to a drive root", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\create file.zip", occurredAt: at, sourceId: "machine" },
      reads,
      window,
    );
    expect(match?.read.path).toBe("create file.zip");
  });

  it("still prefers the deeper match for a file from a subfolder", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\IT\\create file.zip", occurredAt: at, sourceId: "machine" },
      reads,
      window,
    );
    expect(match?.read.path).toBe("IT/create file.zip");
  });

  it("works just as well deep inside a profile", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\Administrator\\Pictures\\create file.zip", occurredAt: at, sourceId: "machine" },
      reads,
      window,
    );
    expect(match?.read.path).toBe("create file.zip");
  });

  it("keeps working when a copy is flattened out of its folder", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\payroll.csv", occurredAt: at, sourceId: "machine" },
      [read("HR/payroll.csv")],
      window,
    );
    expect(match?.read.path).toBe("HR/payroll.csv");
  });
});

describe("inferCrossSourceCopy on a machine people share", () => {
  const window = { beforeMs: 300_000, afterMs: 30_000 };
  const at = new Date("2026-09-19T03:00:00Z");
  const read = (userName: string, path = "HR/payroll.csv"): CrossSourceRead => ({
    id: `r-${userName}-${path}`,
    path,
    action: "READ",
    occurredAt: new Date(at.getTime() - 5_000),
    userName,
    userDomain: "CORP",
    clientIp: null,
    sourceId: "share",
  });

  // A terminal server, or simply two people signed in at once. The copy is
  // real and its origin certain; which of them made it is not. Naming one
  // would put a specific person against something they may not have done.
  it("records where a copy came from but won't name one of two readers", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\Public\\payroll.csv", occurredAt: at, sourceId: "terminal-server" },
      [read("alice"), read("bob")],
      window,
    );
    expect(match?.read.path).toBe("HR/payroll.csv");
    expect(match?.actorCertain).toBe(false);
  });

  it("names the person when only one account read the file", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\alice\\Desktop\\payroll.csv", occurredAt: at, sourceId: "terminal-server" },
      [read("alice")],
      window,
    );
    expect(match?.actorCertain).toBe(true);
    expect(match?.read.userName).toBe("alice");
  });

  // The same person reading a file twice is still one person.
  it("isn't confused by one account reading the file more than once", () => {
    const match = inferCrossSourceCopy(
      { path: "C:\\Users\\alice\\Desktop\\payroll.csv", occurredAt: at, sourceId: "terminal-server" },
      [read("alice"), { ...read("alice"), id: "r-alice-again" }],
      window,
    );
    expect(match?.actorCertain).toBe(true);
  });
});
