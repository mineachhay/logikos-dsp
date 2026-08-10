import type { SensitivePatternType } from "@logikos-dsp/shared";

export interface PatternMatch {
  patternType: SensitivePatternType;
  redactedSample: string;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactKeepLast4(raw: string): string {
  const digitsOnly = raw.replace(/\D/g, "");
  const last4 = digitsOnly.slice(-4);
  return `${"*".repeat(Math.max(digitsOnly.length - 4, 0))}${last4}`;
}

function redactEmail(raw: string): string {
  const [user, domain] = raw.split("@");
  if (!domain) return "***";
  const visible = user.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(user.length - 1, 1))}@${domain}`;
}

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_RE = /\b(?:\d[ -]?){13,16}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g;

/**
 * Scans plain-text content for sensitive-data patterns. Deliberately
 * regex/format-check only (no ML) for v0 — see ARCHITECTURE.md.
 */
export function findSensitivePatterns(content: string): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const m of content.matchAll(SSN_RE)) {
    matches.push({ patternType: "ssn", redactedSample: redactKeepLast4(m[0]) });
  }

  for (const m of content.matchAll(CREDIT_CARD_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      matches.push({ patternType: "credit_card", redactedSample: redactKeepLast4(digits) });
    }
  }

  for (const m of content.matchAll(EMAIL_RE)) {
    matches.push({ patternType: "email", redactedSample: redactEmail(m[0]) });
  }

  for (const m of content.matchAll(PHONE_RE)) {
    matches.push({ patternType: "phone", redactedSample: redactKeepLast4(m[0]) });
  }

  return matches;
}
