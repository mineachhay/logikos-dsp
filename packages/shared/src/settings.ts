// The settings registry: every setting the dashboard's Settings page can
// change, with its type, default, allowed range and where it's used. One list
// drives validation (backend), the page (dashboard) and what agents and
// workers receive — a new setting is one entry here.
//
// What is NOT here, on purpose: secrets and plumbing the system needs to start
// (DATABASE_URL, JWT_SECRET, SOURCE_CREDENTIALS_KEY, AGENT_ENROLL_TOKEN, ports,
// paths). Those stay in the environment, so a bad value in the database can
// never stop the server from coming up to fix it.

export type SettingSection =
  | "general"
  | "detection"
  | "classification"
  | "discovery"
  | "monitoring"
  | "security"
  | "notifications"
  | "agents";

export const SETTING_SECTIONS: { id: SettingSection; label: string; description: string }[] = [
  { id: "general", label: "General", description: "Organisation name, time zone and date format." },
  { id: "detection", label: "Detection rules", description: "When file activity raises an alert." },
  { id: "classification", label: "Classification", description: "Which kinds of sensitive data are looked for, and how seriously they're treated." },
  { id: "discovery", label: "Content discovery", description: "Examining the files already on each share: how fast, when, and what to skip." },
  { id: "monitoring", label: "Monitoring defaults", description: "Defaults for new file servers and shares, and background housekeeping." },
  { id: "security", label: "Security & sign-in", description: "Sessions, lockout and password rules." },
  { id: "notifications", label: "Notifications", description: "Where alerts are sent, and which are sent without approval." },
  { id: "agents", label: "Agents", description: "What the agent install command and remote installs use." },
];

/** Which process reads a setting — agents and workers receive only theirs. */
export type SettingScope = "backend" | "agent" | "classification" | "dashboard";

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export const SEVERITIES: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export type PatternKey = "SSN" | "CREDIT_CARD" | "EMAIL" | "PHONE" | "PERSON" | "ORGANIZATION" | "LOCATION";
export const PATTERN_KEYS: PatternKey[] = ["SSN", "CREDIT_CARD", "EMAIL", "PHONE", "PERSON", "ORGANIZATION", "LOCATION"];

/** Per built-in pattern: whether it's looked for, how serious a match is, and whether it alone raises an alert. */
export interface PatternPolicy {
  enabled: boolean;
  severity: Severity;
  alert: boolean;
}

/** A pattern an admin adds (e.g. a national ID format), tried as a regular expression. */
export interface CustomPattern {
  name: string;
  regex: string;
  enabled: boolean;
  severity: Severity;
  alert: boolean;
  /** "luhn" keeps only digit runs passing the Luhn check (card-like numbers). */
  validator: "none" | "luhn";
}

type Base = {
  key: string;
  section: SettingSection;
  label: string;
  description: string;
  scope: SettingScope[];
  /** Hidden behind "Advanced" — tuning most installs never need. */
  advanced?: boolean;
  /** Shown as a confirmation before saving a change that weakens protection. */
  confirm?: (value: unknown) => string | null;
  /** An environment variable that, when set, overrides this (shown as locked). */
  env?: string;
};

export type SettingDef = Base &
  (
    | { type: "int"; default: number; min: number; max: number; unit?: string }
    | { type: "bool"; default: boolean }
    | { type: "string"; default: string; maxLength: number; pattern?: RegExp; patternHint?: string }
    | { type: "secret"; default: ""; maxLength: number }
    | { type: "enum"; default: string; options: { value: string; label: string }[] }
    | { type: "time"; default: string }
    | { type: "stringList"; default: string[]; maxItems: number; itemMaxLength: number; itemPattern?: RegExp; itemHint?: string }
    | { type: "patternPolicies"; default: Record<PatternKey, PatternPolicy> }
    | { type: "customPatterns"; default: CustomPattern[] }
  );

const sev = (severity: Severity, alert = true, enabled = true): PatternPolicy => ({ enabled, severity, alert });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SETTINGS: SettingDef[] = [
  // ---- General
  { key: "general.orgName", section: "general", label: "Organisation name", description: "Shown in the dashboard header and in notifications.", scope: ["backend", "dashboard"], type: "string", default: "", maxLength: 80 },
  {
    key: "general.timeZone", section: "general", label: "Time zone", scope: ["backend", "agent", "dashboard"], type: "string", default: "UTC", maxLength: 64,
    description: "IANA name, e.g. Asia/Phnom_Penh. Dates on every page, quiet hours and discovery's allowed hours use it.",
    pattern: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$|^UTC$/, patternHint: "an IANA time zone like Asia/Phnom_Penh",
  },
  {
    key: "general.dateFormat", section: "general", label: "Date format", description: "How dates and times are written across the dashboard.", scope: ["dashboard"], type: "enum", default: "en-GB",
    options: [
      { value: "en-GB", label: "27/09/2026, 14:05" },
      { value: "en-US", label: "9/27/2026, 2:05 PM" },
      { value: "sv-SE", label: "2026-09-27 14:05" },
    ],
  },

  // ---- Detection rules
  { key: "detection.ransomware.threshold", section: "detection", label: "Mass-change alert: file changes", description: "Changes on one share within the window that raise the ransomware / mass-change alert.", scope: ["backend"], type: "int", default: 50, min: 10, max: 100_000, unit: "changes" },
  { key: "detection.ransomware.windowSeconds", section: "detection", label: "Mass-change alert: window", description: "The window the changes are counted in.", scope: ["backend"], type: "int", default: 60, min: 10, max: 3600, unit: "seconds" },
  { key: "detection.ransomware.severity", section: "detection", label: "Mass-change alert: severity", description: "", scope: ["backend"], type: "enum", default: "CRITICAL", options: [{ value: "HIGH", label: "High" }, { value: "CRITICAL", label: "Critical" }] },
  { key: "detection.bulkRead.threshold", section: "detection", label: "Bulk-read alert: files", description: "Different files one account reads within the window — what copying a folder off a share looks like. A file server can override it.", scope: ["backend"], type: "int", default: 50, min: 2, max: 10_000, unit: "files" },
  { key: "detection.bulkRead.windowSeconds", section: "detection", label: "Bulk-read alert: window", description: "", scope: ["backend"], type: "int", default: 300, min: 30, max: 86_400, unit: "seconds" },
  { key: "detection.removable.windowSeconds", section: "detection", label: "Copy-to-USB alert: window", description: "Files landing on one USB device within this are one alert.", scope: ["backend"], type: "int", default: 300, min: 30, max: 86_400, unit: "seconds" },
  {
    key: "detection.agentSilence.afterMinutes", section: "detection", label: "Silent-agent alert after", description: "An agent that scans file shares and hasn't reported for this long raises a HIGH alert (the shares it scans aren't being watched).",
    scope: ["backend"], type: "int", default: 15, min: 3, max: 1440, unit: "minutes",
  },
  {
    key: "detection.agentSilence.scope", section: "detection", label: "Silent-agent alert for", description: "Workstations go quiet every time they're shut down, so including them is noisy.",
    scope: ["backend"], type: "enum", default: "servers", options: [{ value: "servers", label: "Agents that scan file shares" }, { value: "all", label: "All agents" }],
  },
  { key: "detection.agentQuietAfterMinutes", section: "detection", label: "Mark agents 'gone quiet' after", description: "On the Agents page and the network coverage view.", scope: ["backend", "dashboard"], type: "int", default: 60, min: 5, max: 10_080, unit: "minutes" },

  // ---- Classification
  {
    key: "classification.patterns", section: "classification", label: "Built-in patterns", scope: ["classification", "dashboard"], type: "patternPolicies",
    description: "Per kind of data: look for it or not, how serious a match is, and whether it raises an alert by itself (otherwise it's only listed on Data Risk).",
    default: { SSN: sev("HIGH"), CREDIT_CARD: sev("HIGH"), PHONE: sev("MEDIUM"), EMAIL: sev("LOW", false), PERSON: sev("LOW", false), ORGANIZATION: sev("LOW", false), LOCATION: sev("LOW", false) },
  },
  {
    key: "classification.customPatterns", section: "classification", label: "Custom patterns", scope: ["classification", "dashboard"], type: "customPatterns",
    description: "Your own formats — national ID numbers, employee numbers, account numbers — as regular expressions. Try each against sample text before enabling it.",
    default: [
      { name: "Cambodian phone number", regex: "(?:\\+855[\\s-]?|\\b0)(?:1\\d|[2-9]\\d)[\\s-]?\\d{3}[\\s-]?\\d{3,4}\\b", enabled: false, severity: "MEDIUM", alert: false, validator: "none" },
    ],
  },
  { key: "classification.minMatches", section: "classification", label: "Matches before a file counts", description: "A file with fewer matches than this (of enabled kinds) isn't recorded — one stray email address in a letter isn't a finding.", scope: ["classification"], type: "int", default: 1, min: 1, max: 100, unit: "matches" },
  { key: "classification.ner.enabled", section: "classification", label: "Detect names, organisations and places", description: "The local language model that finds people, organisations and locations. Off makes classification faster; patterns still run.", scope: ["classification"], type: "bool", default: true },
  { key: "classification.ner.confidence", section: "classification", label: "Name detection confidence", description: "How sure the model must be (50–99). Higher means fewer, surer matches.", scope: ["classification"], type: "int", default: 85, min: 50, max: 99, unit: "%", advanced: true },

  // ---- Content discovery
  { key: "discovery.enabled", section: "discovery", label: "Examine existing files", description: "Work through each share's files in the background, not only files that change.", scope: ["agent"], type: "bool", default: true },
  { key: "discovery.filesPerSecond", section: "discovery", label: "Speed", description: "Files read per second, across all shares together. Each is read whole over the network.", scope: ["agent"], type: "int", default: 2, min: 1, max: 20, unit: "files/s" },
  { key: "discovery.allowedFrom", section: "discovery", label: "Only between", description: "Start of the daily window discovery may read in (in the general time zone). The same start and end means any time.", scope: ["agent"], type: "time", default: "00:00" },
  { key: "discovery.allowedUntil", section: "discovery", label: "…and", description: "End of the window. A window across midnight (19:00 → 07:00) works.", scope: ["agent"], type: "time", default: "00:00" },
  { key: "discovery.weekendsAnyTime", section: "discovery", label: "Any time at weekends", description: "Ignore the window on Saturday and Sunday.", scope: ["agent"], type: "bool", default: true },
  { key: "discovery.repassDays", section: "discovery", label: "Look again every", description: "A new pass re-examines files that changed without being noticed.", scope: ["agent"], type: "int", default: 7, min: 1, max: 365, unit: "days" },
  { key: "discovery.maxFileMb", section: "discovery", label: "Largest file examined", description: "Bigger files are skipped (and counted).", scope: ["agent"], type: "int", default: 25, min: 1, max: 500, unit: "MB" },
  {
    key: "discovery.fileTypes", section: "discovery", label: "File types", description: "Which kinds of file have their text extracted.", scope: ["agent"], type: "stringList", default: ["text", "docx", "xlsx", "pptx", "pdf"], maxItems: 5, itemMaxLength: 8,
    itemPattern: /^(text|docx|xlsx|pptx|pdf)$/, itemHint: "text, docx, xlsx, pptx or pdf",
  },
  {
    key: "discovery.exclude", section: "discovery", label: "Skip paths matching", scope: ["agent"], type: "stringList", maxItems: 50, itemMaxLength: 200,
    description: "One pattern per line, matched against the path inside the share. * matches within a folder name, ** across folders. Office's ~$ lock files and the recycle bin are always skipped.",
    default: ["**/Backup/**", "**/*.bak"],
  },

  // ---- Monitoring defaults
  { key: "monitoring.defaultScanIntervalSec", section: "monitoring", label: "Scan new shares every", description: "The starting value when a share is added (each share can differ).", scope: ["dashboard"], type: "int", default: 300, min: 60, max: 86_400, unit: "seconds" },
  { key: "monitoring.defaultRecordReads", section: "monitoring", label: "Record reads on new file servers", description: "Reads show copies out of a share, but are most of a busy server's audit volume.", scope: ["dashboard"], type: "bool", default: false },
  { key: "monitoring.reverseDns", section: "monitoring", label: "Name the PC a change came from", description: "Look up each client IP's name in DNS when a change is recorded.", scope: ["backend"], type: "bool", default: true },
  { key: "monitoring.snapshotThinning", section: "monitoring", label: "Thin out old storage snapshots", description: "Keep one per hour after a day and one per day after 30 days, instead of one per scan forever.", scope: ["backend"], type: "bool", default: true },

  // ---- Security & sign-in
  { key: "security.sessionIdleHours", section: "security", label: "Sign out after inactivity", description: "", scope: ["backend"], type: "int", default: 12, min: 1, max: 168, unit: "hours" },
  {
    key: "security.lockAfterFailures", section: "security", label: "Lock an account after", description: "Wrong passwords in a row; the lock then lengthens (1 → 30 minutes) if it continues.", scope: ["backend"], type: "int", default: 5, min: 3, max: 50, unit: "failures",
    confirm: (v) => (Number(v) > 10 ? "More than 10 tries makes password guessing much easier. Continue?" : null),
  },
  { key: "security.ipFailureLimit", section: "security", label: "Block an address after", description: "Failed sign-ins from one address, across all accounts, within the window below.", scope: ["backend"], type: "int", default: 20, min: 5, max: 500, unit: "failures" },
  { key: "security.ipWindowMinutes", section: "security", label: "…within", description: "", scope: ["backend"], type: "int", default: 15, min: 1, max: 1440, unit: "minutes", advanced: true },
  { key: "security.ipBlockMinutes", section: "security", label: "…for", description: "How long the address is blocked.", scope: ["backend"], type: "int", default: 15, min: 1, max: 1440, unit: "minutes", advanced: true },
  {
    key: "security.passwordMinLength", section: "security", label: "Minimum password length", description: "For new and changed local passwords (AD passwords follow AD's policy).", scope: ["backend"], type: "int", default: 12, min: 8, max: 64, unit: "characters",
    confirm: (v) => (Number(v) < 12 ? "Passwords shorter than 12 characters are much easier to guess. Continue?" : null),
  },

  // ---- Notifications
  { key: "notify.telegram.botToken", section: "notifications", label: "Telegram bot token", description: "From @BotFather. Stored encrypted.", scope: ["backend"], type: "secret", default: "", maxLength: 200, env: "TELEGRAM_BOT_TOKEN" },
  { key: "notify.telegram.chatId", section: "notifications", label: "Telegram chat ID", description: "The chat, group or channel alerts go to.", scope: ["backend"], type: "string", default: "", maxLength: 64, pattern: /^$|^-?\d+$|^@\w+$/, patternHint: "a number like -1001234567890, or @channelname", env: "TELEGRAM_CHAT_ID" },
  { key: "notify.webhook.url", section: "notifications", label: "Webhook URL", description: "Receives each approved notification as JSON (POST).", scope: ["backend"], type: "string", default: "", maxLength: 500, pattern: /^$|^https?:\/\/\S+$/, patternHint: "an http(s):// URL", env: "RESPONSE_WEBHOOK_URL" },
  { key: "notify.email.host", section: "notifications", label: "Email: SMTP server", description: "e.g. smtp.office365.com. Empty turns email off.", scope: ["backend"], type: "string", default: "", maxLength: 200, pattern: /^$|^[A-Za-z0-9.-]+$/, patternHint: "a host name" },
  { key: "notify.email.port", section: "notifications", label: "Email: port", description: "587 (STARTTLS) or 465 (TLS).", scope: ["backend"], type: "int", default: 587, min: 1, max: 65535 },
  { key: "notify.email.username", section: "notifications", label: "Email: user name", description: "Empty for a relay that needs no sign-in.", scope: ["backend"], type: "string", default: "", maxLength: 200 },
  { key: "notify.email.password", section: "notifications", label: "Email: password", description: "Stored encrypted.", scope: ["backend"], type: "secret", default: "", maxLength: 200 },
  { key: "notify.email.from", section: "notifications", label: "Email: from", description: "", scope: ["backend"], type: "string", default: "", maxLength: 200, pattern: /^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternHint: "an email address" },
  { key: "notify.email.to", section: "notifications", label: "Email: send to", description: "One address per line.", scope: ["backend"], type: "stringList", default: [], maxItems: 20, itemMaxLength: 200, itemPattern: EMAIL_RE, itemHint: "an email address" },
  {
    key: "notify.suggestFromSeverity", section: "notifications", label: "Offer a notification for alerts from", description: "Alerts at or above this get a notification waiting for approval on the Alerts page.",
    scope: ["backend"], type: "enum", default: "HIGH", options: SEVERITIES.map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() })),
  },
  {
    key: "notify.autoSend", section: "notifications", label: "Send without approval", scope: ["backend"], type: "stringList", maxItems: 12, itemMaxLength: 40, itemPattern: /^[A-Z_]+$/, itemHint: "an alert type",
    description: "Alert types whose notification goes out immediately instead of waiting for an admin — for things nobody should have to approve, like an agent going silent. Approve-first stays the rule for everything else.",
    default: ["AGENT_SILENT", "BACKUP_FAILED"],
    confirm: (v) => (Array.isArray(v) && v.length > 4 ? "Many alert types sent automatically can become noise people learn to ignore. Continue?" : null),
  },
  { key: "notify.quietFrom", section: "notifications", label: "Quiet hours from", description: "Automatic notifications in quiet hours wait for approval instead (the same start and end means no quiet hours).", scope: ["backend"], type: "time", default: "00:00" },
  { key: "notify.quietUntil", section: "notifications", label: "…until", description: "", scope: ["backend"], type: "time", default: "00:00" },

  // ---- Agents
  { key: "agents.installCa", section: "agents", label: "Certificate option for installs", description: "Only when the dashboard's certificate isn't publicly trusted: 'cloudflare-origin' behind Cloudflare's origin CA. Empty otherwise.", scope: ["backend"], type: "string", default: "", maxLength: 40, pattern: /^$|^[a-z0-9-]+$/, patternHint: "empty, or e.g. cloudflare-origin", env: "AGENT_INSTALL_CA" },
  { key: "agents.defaultWatchPath", section: "agents", label: "Default folder to watch", description: "Pre-filled in the install command and remote installs.", scope: ["dashboard"], type: "string", default: "C:\\Users", maxLength: 260 },
  { key: "agents.defaultAllDrives", section: "agents", label: "Watch every fixed drive by default", description: "", scope: ["dashboard"], type: "bool", default: true },
  { key: "agents.defaultRemovable", section: "agents", label: "Watch USB storage by default", description: "", scope: ["dashboard"], type: "bool", default: true },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Checks a value against its definition. Returns an error message, or null when it's valid. */
export function settingProblem(def: SettingDef, value: unknown): string | null {
  switch (def.type) {
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) return "must be a whole number";
      if (value < def.min || value > def.max) return `must be between ${def.min} and ${def.max}`;
      return null;
    case "bool":
      return typeof value === "boolean" ? null : "must be on or off";
    case "string":
    case "secret":
      if (typeof value !== "string") return "must be text";
      if (value.length > def.maxLength) return `at most ${def.maxLength} characters`;
      if (def.type === "string" && def.pattern && !def.pattern.test(value)) return `must be ${def.patternHint ?? "in the right format"}`;
      if (def.key === "general.timeZone" && !isTimeZone(value)) return "isn't a time zone this server knows";
      return null;
    case "enum":
      return def.options.some((o) => o.value === value) ? null : `must be one of ${def.options.map((o) => o.value).join(", ")}`;
    case "time":
      return typeof value === "string" && TIME_RE.test(value) ? null : "must be a time like 19:00";
    case "stringList": {
      if (!Array.isArray(value)) return "must be a list";
      if (value.length > def.maxItems) return `at most ${def.maxItems} entries`;
      for (const item of value) {
        if (typeof item !== "string" || !item.trim()) return "entries can't be empty";
        if (item.length > def.itemMaxLength) return `entries are at most ${def.itemMaxLength} characters`;
        if (def.itemPattern && !def.itemPattern.test(item)) return `"${item}" isn't ${def.itemHint ?? "valid"}`;
      }
      return null;
    }
    case "patternPolicies": {
      if (!value || typeof value !== "object") return "must be a list of patterns";
      for (const k of PATTERN_KEYS) {
        const p = (value as Record<string, PatternPolicy>)[k];
        if (!p || typeof p.enabled !== "boolean" || typeof p.alert !== "boolean" || !SEVERITIES.includes(p.severity)) return `${k}: needs on/off, severity and alert`;
      }
      return null;
    }
    case "customPatterns": {
      if (!Array.isArray(value)) return "must be a list";
      if (value.length > 30) return "at most 30 custom patterns";
      for (const p of value as CustomPattern[]) {
        if (!p || typeof p.name !== "string" || !p.name.trim() || p.name.length > 60) return "each pattern needs a name (up to 60 characters)";
        const problem = regexProblem(p.regex);
        if (problem) return `${p.name}: ${problem}`;
        if (typeof p.enabled !== "boolean" || typeof p.alert !== "boolean" || !SEVERITIES.includes(p.severity)) return `${p.name}: needs on/off, severity and alert`;
        if (p.validator !== "none" && p.validator !== "luhn") return `${p.name}: validator must be none or luhn`;
      }
      return null;
    }
  }
}

/**
 * A custom pattern runs over up to 32 KB of text per file with no way to
 * interrupt it, so length is capped and the classic catastrophic-backtracking
 * shapes — a quantified group that is itself quantified, like (a+)+ — are refused.
 */
export function regexProblem(source: unknown): string | null {
  if (typeof source !== "string" || !source) return "needs a regular expression";
  if (source.length > 300) return "the expression is too long (300 characters at most)";
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(source)) return "a repeated group containing a repeat, like (a+)+, can hang on some text — rewrite it";
  try {
    new RegExp(source, "g");
  } catch (err) {
    return `isn't a valid regular expression (${(err as Error).message})`;
  }
  return null;
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes past midnight for "HH:MM". */
export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Whether `now` (in `timeZone`) falls in [from, until); equal ends mean always. Handles windows across midnight. */
export function inDailyWindow(now: Date, from: string, until: string, timeZone: string): boolean {
  const start = minutesOf(from);
  const end = minutesOf(until);
  if (start === end) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const mins = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}

/** Saturday or Sunday in `timeZone`. */
export function isWeekend(now: Date, timeZone: string): boolean {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  return day === "Sat" || day === "Sun";
}

/** A glob against a "/"-separated relative path: * within a name, ** across folders, ? one character. Case-insensitive, like Windows. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** Paths discovery always skips, whatever is configured: Office lock files and recycle bins. */
export const ALWAYS_EXCLUDED = ["**/~$*", "**/$RECYCLE.BIN/**", "$RECYCLE.BIN/**", "**/System Volume Information/**"];
