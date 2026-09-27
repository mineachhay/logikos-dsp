// What a file's matches amount to, under Settings → Classification. Pure, so
// it's unit tested; index.ts applies it to every job.
import { SEVERITIES, type CustomPattern, type PatternKey, type PatternPolicy, type Severity } from "@logikos-dsp/shared";
import type { PatternMatch } from "./patterns.js";

export interface KeptMatch {
  /** Built-in kind (SSN, EMAIL, …) or "CUSTOM". */
  patternType: PatternKey | "CUSTOM";
  customName: string | null;
  redactedSample: string;
  severity: Severity;
  alert: boolean;
}

export interface Verdict {
  kept: KeptMatch[];
  /** Severity of the alert this file raises, or null when none should be raised. */
  alertSeverity: Severity | null;
}

const BUILT_IN: Record<string, PatternKey> = {
  ssn: "SSN",
  credit_card: "CREDIT_CARD",
  email: "EMAIL",
  phone: "PHONE",
  person: "PERSON",
  organization: "ORGANIZATION",
  location: "LOCATION",
};

/** Every match not of an enabled kind is dropped; fewer than `minMatches` left means the file isn't a finding at all. */
export function applyPolicy(
  builtIn: readonly PatternMatch[],
  custom: readonly KeptMatch[],
  policies: Record<PatternKey, PatternPolicy>,
  minMatches: number,
): Verdict {
  const kept: KeptMatch[] = [];
  for (const m of builtIn) {
    const key = BUILT_IN[m.patternType];
    const policy = key ? policies[key] : undefined;
    if (!key || !policy?.enabled) continue;
    kept.push({ patternType: key, customName: null, redactedSample: m.redactedSample, severity: policy.severity, alert: policy.alert });
  }
  kept.push(...custom);
  if (kept.length < minMatches) return { kept: [], alertSeverity: null };
  const alerting = kept.filter((k) => k.alert);
  const alertSeverity = alerting.length ? alerting.reduce<Severity>((max, k) => (SEVERITIES.indexOf(k.severity) > SEVERITIES.indexOf(max) ? k.severity : max), "LOW") : null;
  return { kept, alertSeverity };
}

function luhn(digits: string): boolean {
  if (digits.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

/** Everything but the last four characters masked, like the built-in patterns. */
function redact(value: string): string {
  const v = value.trim();
  return v.length <= 4 ? "*".repeat(v.length) : "*".repeat(v.length - 4) + v.slice(-4);
}

/** Runs the enabled custom patterns over `text` (at most 20 matches per pattern). */
export function findCustomPatterns(text: string, patterns: readonly CustomPattern[]): KeptMatch[] {
  const out: KeptMatch[] = [];
  for (const p of patterns) {
    if (!p.enabled) continue;
    let re: RegExp;
    try {
      re = new RegExp(p.regex, "g");
    } catch {
      continue; // validated on save; a bad one here is skipped, not fatal
    }
    let found = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      if (p.validator === "luhn" && !luhn(m[0].replace(/\D/g, ""))) continue;
      out.push({ patternType: "CUSTOM", customName: p.name, redactedSample: redact(m[0]), severity: p.severity, alert: p.alert });
      if (++found >= 20) break;
    }
  }
  return out;
}
