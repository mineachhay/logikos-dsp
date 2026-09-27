/**
 * Dates across the dashboard, in the time zone and format chosen under
 * Settings → General rather than whatever the viewing browser happens to use —
 * an alert at 02:00 means the same thing to everyone looking at it. Set once
 * by the SettingsProvider; until then (and if the zone is unknown) the
 * browser's own conventions apply.
 */
let locale: string | undefined;
let timeZone: string | undefined;

export function setDateConventions(next: { locale?: string; timeZone?: string }) {
  locale = next.locale;
  try {
    // Throws for a zone this browser doesn't know; fall back rather than break every page.
    new Intl.DateTimeFormat(undefined, { timeZone: next.timeZone });
    timeZone = next.timeZone;
  } catch {
    timeZone = undefined;
  }
}

type DateInput = string | number | Date;

export function fmtDateTime(value: DateInput): string {
  return new Date(value).toLocaleString(locale, { timeZone, dateStyle: "short", timeStyle: "short" });
}

export function fmtDate(value: DateInput): string {
  return new Date(value).toLocaleDateString(locale, { timeZone });
}

export function fmtTime(value: DateInput): string {
  return new Date(value).toLocaleTimeString(locale, { timeZone, timeStyle: "short" });
}
