import type pg from "pg";
import { SETTINGS_BY_KEY, type CustomPattern, type PatternKey, type PatternPolicy } from "@logikos-dsp/shared";

export interface ClassificationSettings {
  patterns: Record<PatternKey, PatternPolicy>;
  customPatterns: CustomPattern[];
  minMatches: number;
  nerEnabled: boolean;
  nerConfidence: number;
}

const KEYS = {
  patterns: "classification.patterns",
  customPatterns: "classification.customPatterns",
  minMatches: "classification.minMatches",
  nerEnabled: "classification.ner.enabled",
  nerConfidence: "classification.ner.confidence",
} as const;

let cache: { at: number; value: ClassificationSettings } | null = null;

/**
 * Settings → Classification, read straight from the Setting table (this
 * worker talks to the database with raw pg, like the rest of it) over the
 * registry's defaults. Cached for 10 s, so a change applies within seconds.
 */
export async function classificationSettings(pool: pg.Pool): Promise<ClassificationSettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const { rows } = await pool.query(`SELECT "key", "value" FROM "Setting" WHERE "key" LIKE 'classification.%'`);
  const saved = new Map(rows.map((r: { key: string; value: unknown }) => [r.key, r.value]));
  const get = <T>(key: string): T => (saved.has(key) ? saved.get(key) : SETTINGS_BY_KEY.get(key)!.default) as T;
  const value: ClassificationSettings = {
    patterns: get(KEYS.patterns),
    customPatterns: get(KEYS.customPatterns),
    minMatches: get(KEYS.minMatches),
    nerEnabled: get(KEYS.nerEnabled),
    nerConfidence: get(KEYS.nerConfidence),
  };
  cache = { at: Date.now(), value };
  return value;
}
