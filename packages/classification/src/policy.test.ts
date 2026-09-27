import { describe, expect, it } from "vitest";
import { SETTINGS_BY_KEY, type CustomPattern, type PatternKey, type PatternPolicy } from "@logikos-dsp/shared";
import { applyPolicy, findCustomPatterns } from "./policy.js";

const defaults = SETTINGS_BY_KEY.get("classification.patterns")!.default as Record<PatternKey, PatternPolicy>;

describe("applyPolicy", () => {
  it("alerts at the highest severity among alerting kinds, and lists low-signal kinds without alerting", () => {
    const v = applyPolicy([{ patternType: "email", redactedSample: "j***@x" }, { patternType: "ssn", redactedSample: "*****6789" }], [], defaults, 1);
    expect(v.kept.map((k) => k.patternType)).toEqual(["EMAIL", "SSN"]);
    expect(v.alertSeverity).toBe("HIGH");
  });

  it("records emails without raising an alert by default", () => {
    const v = applyPolicy([{ patternType: "email", redactedSample: "j***@x" }], [], defaults, 1);
    expect(v).toMatchObject({ kept: [{ patternType: "EMAIL" }], alertSeverity: null });
  });

  it("drops disabled kinds, and a file under the minimum isn't a finding", () => {
    const off = { ...defaults, EMAIL: { ...defaults.EMAIL, enabled: false } };
    expect(applyPolicy([{ patternType: "email", redactedSample: "x" }], [], off, 1).kept).toEqual([]);
    expect(applyPolicy([{ patternType: "ssn", redactedSample: "x" }], [], defaults, 2)).toEqual({ kept: [], alertSeverity: null });
  });
});

describe("findCustomPatterns", () => {
  const phone: CustomPattern = { name: "Cambodian phone", regex: "(?:\\+855[\\s-]?|\\b0)(?:1\\d|[2-9]\\d)[\\s-]?\\d{3}[\\s-]?\\d{3,4}\\b", enabled: true, severity: "MEDIUM", alert: false, validator: "none" };

  it("finds and redacts matches of an enabled pattern", () => {
    const found = findCustomPatterns("Call +855 12 345 678 or 012 345 6789.", [phone]);
    expect(found.map((f) => f.redactedSample)).toEqual(["*********** 678", "********6789"]); // all but the last four
    expect(found[0]).toMatchObject({ patternType: "CUSTOM", customName: "Cambodian phone", severity: "MEDIUM" });
  });

  it("skips disabled patterns and applies the Luhn check", () => {
    expect(findCustomPatterns("+855 12 345 678", [{ ...phone, enabled: false }])).toEqual([]);
    const card: CustomPattern = { name: "16 digits", regex: "\\b\\d{16}\\b", enabled: true, severity: "HIGH", alert: true, validator: "luhn" };
    expect(findCustomPatterns("4111111111111111 4111111111111112", [card])).toHaveLength(1);
  });
});
