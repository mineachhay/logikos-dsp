import { describe, expect, it } from "vitest";
import {
  BUNDLE_FILE_PATTERN,
  DUMP_FILE_PATTERN,
  bundleFileName,
  dueSlot,
  dumpFileName,
  isAgeRecipient,
  latestDailySlot,
  latestVerifySlot,
  nextDailySlot,
  nextVerifySlot,
  selectForRetention,
} from "./backups.js";

const at = (iso: string) => new Date(iso);

describe("file naming", () => {
  it("matches deploy/backup.sh's dump names, so restore.sh finds worker dumps", () => {
    expect(dumpFileName(at("2026-09-14T10:02:09.123Z"))).toBe("logikos_dsp-20260914T100209Z.dump");
    expect(DUMP_FILE_PATTERN.test("logikos_dsp-20260914T100209Z.dump")).toBe(true);
    expect(bundleFileName(at("2026-09-14T10:02:09Z"))).toBe("logikos-dsp-20260914T100209Z.tar.age");
    expect(BUNDLE_FILE_PATTERN.test("logikos-dsp-20260914T100209Z.tar.age")).toBe(true);
  });
});

describe("selectForRetention", () => {
  it("deletes the oldest beyond `keep` and never touches files that aren't ours", () => {
    const names = [
      "logikos-dsp-20260903T031500Z.tar.age",
      "notes.txt",
      "logikos-dsp-20260901T031500Z.tar.age",
      "logikos-dsp-20260902T031500Z.tar.age",
      "logikos-dsp-20260904T031500Z.tar.age",
    ];
    expect(selectForRetention(names, BUNDLE_FILE_PATTERN, 2)).toEqual([
      "logikos-dsp-20260901T031500Z.tar.age",
      "logikos-dsp-20260902T031500Z.tar.age",
    ]);
  });

  it("always keeps at least one, even if misconfigured to keep zero", () => {
    expect(selectForRetention(["logikos-dsp-20260901T031500Z.tar.age"], BUNDLE_FILE_PATTERN, 0)).toEqual([]);
  });
});

describe("isAgeRecipient", () => {
  it("accepts a real age public key and rejects private keys and garbage", () => {
    expect(isAgeRecipient("age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p")).toBe(true);
    expect(isAgeRecipient("AGE-SECRET-KEY-1QQQ")).toBe(false);
    expect(isAgeRecipient("age1short")).toBe(false);
    expect(isAgeRecipient("ssh-ed25519 AAAAC3Nza")).toBe(false);
  });
});

describe("schedule slots (UTC)", () => {
  it("finds today's slot once it has passed, else yesterday's", () => {
    expect(latestDailySlot(at("2026-09-15T04:00:00Z"), "03:15")).toEqual(at("2026-09-15T03:15:00Z"));
    expect(latestDailySlot(at("2026-09-15T03:00:00Z"), "03:15")).toEqual(at("2026-09-14T03:15:00Z"));
    expect(nextDailySlot(at("2026-09-15T03:00:00Z"), "03:15")).toEqual(at("2026-09-15T03:15:00Z"));
  });

  it("puts the weekly restore check an hour after that weekday's backup", () => {
    // 2026-09-13 is a Sunday.
    expect(latestVerifySlot(at("2026-09-15T12:00:00Z"), "03:15", 0)).toEqual(at("2026-09-13T04:15:00Z"));
    expect(latestVerifySlot(at("2026-09-13T04:00:00Z"), "03:15", 0)).toEqual(at("2026-09-06T04:15:00Z"));
    expect(nextVerifySlot(at("2026-09-15T12:00:00Z"), "03:15", 0)).toEqual(at("2026-09-20T04:15:00Z"));
  });
});

describe("dueSlot", () => {
  const latestSlot = at("2026-09-15T03:15:00Z");
  const now = at("2026-09-15T12:00:00Z");

  it("doesn't fire a slot from before the schedule was turned on", () => {
    expect(dueSlot({ now, latestSlot, activeSince: at("2026-09-15T11:00:00Z"), lastRunSlot: null })).toBeNull();
  });

  it("fires a slot after activation that hasn't run, once", () => {
    const activeSince = at("2026-09-14T09:00:00Z");
    expect(dueSlot({ now, latestSlot, activeSince, lastRunSlot: at("2026-09-14T03:15:00Z") })).toEqual(latestSlot);
    expect(dueSlot({ now, latestSlot, activeSince, lastRunSlot: latestSlot })).toBeNull();
  });

  it("never fires while the schedule is off", () => {
    expect(dueSlot({ now, latestSlot, activeSince: null, lastRunSlot: null })).toBeNull();
  });
});
