import { SETTINGS, SETTINGS_BY_KEY, settingProblem, type SettingDef, type SettingScope } from "@logikos-dsp/shared";
import { decryptSecret, encryptSecret } from "@logikos-dsp/shared/credentials";
import { prisma } from "./db.js";

/**
 * Effective settings: an environment variable (when the registry names one
 * and it's set) wins, then a value saved on the Settings page, then the
 * default in code. Read on the hot path (every login, every ingest), so the
 * saved overrides are cached for a few seconds and dropped on every save.
 */
const CACHE_MS = 5000;
let cache: { at: number; rows: Map<string, { value: unknown; updatedAt: Date; updatedByEmail: string | null }> } | null = null;

async function overrides() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await prisma.setting.findMany();
  cache = { at: Date.now(), rows: new Map(rows.map((r) => [r.key, { value: r.value, updatedAt: r.updatedAt, updatedByEmail: r.updatedByEmail }])) };
  return cache.rows;
}

export function invalidateSettings(): void {
  cache = null;
}

function envValue(def: SettingDef): unknown | undefined {
  if (!def.env) return undefined;
  const raw = process.env[def.env];
  if (raw === undefined || raw === "") return undefined;
  if (def.type === "int") return Number(raw);
  if (def.type === "bool") return raw !== "false";
  return raw;
}

function decode(def: SettingDef, stored: unknown): unknown {
  if (def.type !== "secret") return stored;
  try {
    return typeof stored === "string" && stored ? decryptSecret(stored) : "";
  } catch {
    return ""; // encrypted with another key (e.g. restored elsewhere): treat as unset
  }
}

export async function setting<T = unknown>(key: string): Promise<T> {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def) throw new Error(`unknown setting ${key}`);
  const env = envValue(def);
  if (env !== undefined) return env as T;
  const row = (await overrides()).get(key);
  return (row ? decode(def, row.value) : def.default) as T;
}

/** Everything one component reads, e.g. for an agent's /agent-sync. Secrets are never included. */
export async function settingsFor(scope: SettingScope): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const def of SETTINGS) if (def.scope.includes(scope) && def.type !== "secret") out[def.key] = await setting(def.key);
  return out;
}

/** The registry for the Settings page, with current values. Secrets say only whether they're set. */
export async function describeSettings() {
  const rows = await overrides();
  return Promise.all(
    SETTINGS.map(async (def) => {
      const row = rows.get(def.key);
      const env = envValue(def);
      const value = await setting(def.key);
      const { confirm, ...rest } = def;
      return {
        ...rest,
        // RegExps don't survive JSON; the page gets the hint instead and the server validates.
        pattern: undefined,
        itemPattern: undefined,
        needsConfirmation: Boolean(confirm),
        value: def.type === "secret" ? undefined : value,
        isSet: def.type === "secret" ? Boolean(value) : undefined,
        source: env !== undefined ? "env" : row ? "saved" : "default",
        updatedAt: row?.updatedAt ?? null,
        updatedByEmail: row?.updatedByEmail ?? null,
      };
    }),
  );
}

export type ChangeResult =
  | { ok: true; changed: { key: string; from: unknown; to: unknown }[] }
  | { ok: false; status: 400 | 409; error: string; confirmations?: string[] };

/**
 * Validates and saves changes. Nothing is saved unless every change is valid.
 * A change that weakens protection needs `confirmed` (the page asks first).
 * A secret set to null keeps its stored value; "" clears it.
 */
export async function applySettingChanges(changes: Record<string, unknown>, by: string, confirmed: boolean): Promise<ChangeResult> {
  const confirmations: string[] = [];
  const planned: { def: SettingDef; value: unknown; reset: boolean }[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) return { ok: false, status: 400, error: `unknown setting ${key}` };
    if (envValue(def) !== undefined) return { ok: false, status: 400, error: `${def.label} is set by the server's configuration (${def.env}) and can't be changed here` };
    if (def.type === "secret" && value === null) continue;
    const reset = value === undefined;
    if (!reset) {
      const problem = settingProblem(def, value);
      if (problem) return { ok: false, status: 400, error: `${def.label}: ${problem}` };
      const warning = def.confirm?.(value);
      if (warning) confirmations.push(`${def.label}: ${warning}`);
    }
    planned.push({ def, value, reset });
  }
  if (confirmations.length && !confirmed) return { ok: false, status: 409, error: "confirmation needed", confirmations };

  const changed: { key: string; from: unknown; to: unknown }[] = [];
  await prisma.$transaction(async (tx) => {
    for (const { def, value, reset } of planned) {
      const from = await setting(def.key);
      const to = reset ? def.default : value;
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      if (reset || JSON.stringify(to) === JSON.stringify(def.default)) await tx.setting.deleteMany({ where: { key: def.key } });
      else {
        const stored = def.type === "secret" ? (to ? encryptSecret(String(to)) : "") : to;
        await tx.setting.upsert({ where: { key: def.key }, create: { key: def.key, value: stored as never, updatedByEmail: by }, update: { value: stored as never, updatedByEmail: by } });
      }
      // Secrets are recorded as changed, never as values.
      changed.push(def.type === "secret" ? { key: def.key, from: from ? "(set)" : "(empty)", to: to ? "(set)" : "(empty)" } : { key: def.key, from, to });
    }
  });
  invalidateSettings();
  return { ok: true, changed };
}
