import { describe, expect, it } from "vitest";
import { SETTINGS, SETTINGS_BY_KEY, globToRegExp, inDailyWindow, isWeekend, regexProblem, settingProblem } from "./settings.js";

const def = (key: string) => SETTINGS_BY_KEY.get(key)!;

describe("settings registry", () => {
  it("has unique keys, and every default passes its own validation", () => {
    expect(new Set(SETTINGS.map((s) => s.key)).size).toBe(SETTINGS.length);
    for (const s of SETTINGS) expect(settingProblem(s, s.default), s.key).toBeNull();
  });

  it("enforces ranges, formats and list items", () => {
    expect(settingProblem(def("detection.ransomware.threshold"), 5)).toMatch(/between 10/);
    expect(settingProblem(def("detection.ransomware.threshold"), 12.5)).toMatch(/whole number/);
    expect(settingProblem(def("general.timeZone"), "Asia/Phnom_Penh")).toBeNull();
    expect(settingProblem(def("general.timeZone"), "Mars/Olympus")).toMatch(/time zone/);
    expect(settingProblem(def("notify.email.to"), ["ok@corp.example", "nope"])).toMatch(/"nope"/);
    expect(settingProblem(def("discovery.allowedFrom"), "25:00")).toMatch(/time/);
    expect(settingProblem(def("detection.ransomware.severity"), "LOW")).toMatch(/one of/);
  });

  it("asks for confirmation before weakening protection", () => {
    expect(def("security.lockAfterFailures").confirm!(20)).toMatch(/guessing/);
    expect(def("security.lockAfterFailures").confirm!(5)).toBeNull();
  });
});

describe("regexProblem", () => {
  it("accepts ordinary patterns and refuses broken or catastrophic ones", () => {
    expect(regexProblem("\\b\\d{9}\\b")).toBeNull();
    expect(regexProblem("(a+)+$")).toMatch(/hang/);
    expect(regexProblem("[unclosed")).toMatch(/valid/);
    expect(regexProblem("x".repeat(301))).toMatch(/too long/);
  });
});

describe("time windows", () => {
  const at = (iso: string) => new Date(iso);
  it("handles a window across midnight in the configured time zone", () => {
    // 20:00 in Phnom Penh (UTC+7) is 13:00 UTC.
    expect(inDailyWindow(at("2026-09-28T13:00:00Z"), "19:00", "07:00", "Asia/Phnom_Penh")).toBe(true);
    expect(inDailyWindow(at("2026-09-28T05:00:00Z"), "19:00", "07:00", "Asia/Phnom_Penh")).toBe(false); // 12:00 local
    expect(inDailyWindow(at("2026-09-28T05:00:00Z"), "00:00", "00:00", "Asia/Phnom_Penh")).toBe(true); // no window
  });
  it("knows the weekend in the configured time zone", () => {
    expect(isWeekend(at("2026-09-26T20:00:00Z"), "Asia/Phnom_Penh")).toBe(true); // Sunday 03:00 local
    expect(isWeekend(at("2026-09-27T20:00:00Z"), "Asia/Phnom_Penh")).toBe(false); // Monday 03:00 local
  });
});

describe("globToRegExp", () => {
  it("matches like people expect paths to match", () => {
    expect(globToRegExp("**/Backup/**").test("HR/Backup/2024/x.docx")).toBe(true);
    expect(globToRegExp("**/Backup/**").test("Backup/x.docx")).toBe(true);
    expect(globToRegExp("**/*.bak").test("a/b/c.BAK")).toBe(true);
    expect(globToRegExp("**/~$*").test("HR/~$report.docx")).toBe(true);
    expect(globToRegExp("*.tmp").test("a/b.tmp")).toBe(false); // * stays inside one folder
  });
});
