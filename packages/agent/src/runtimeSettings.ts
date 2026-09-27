// Settings the backend sends with every /agent-sync (Settings page, scope
// "agent"). Before the first sync, or from an older backend, the registry's
// defaults apply. An environment variable set on the agent itself still wins
// for the few that have one (DISCOVERY_*), so a machine can be pinned locally.
import { SETTINGS_BY_KEY, globToRegExp, ALWAYS_EXCLUDED } from "@logikos-dsp/shared";

let synced: Record<string, unknown> = {};

export function setRuntimeSettings(settings: Record<string, unknown> | undefined): void {
  if (settings) synced = settings;
}

function get<T>(key: string): T {
  return (key in synced ? synced[key] : SETTINGS_BY_KEY.get(key)!.default) as T;
}

export interface DiscoverySettings {
  enabled: boolean;
  filesPerSecond: number;
  allowedFrom: string;
  allowedUntil: string;
  weekendsAnyTime: boolean;
  timeZone: string;
  repassMs: number;
  maxFileBytes: number;
  fileTypes: Set<string>;
  exclude: RegExp[];
}

export function discoverySettings(): DiscoverySettings {
  const env = process.env;
  const excludeGlobs = [...ALWAYS_EXCLUDED, ...get<string[]>("discovery.exclude")];
  return {
    enabled: env.DISCOVERY_ENABLED ? env.DISCOVERY_ENABLED !== "false" : get<boolean>("discovery.enabled"),
    filesPerSecond: env.DISCOVERY_FILES_PER_SEC ? Number(env.DISCOVERY_FILES_PER_SEC) : get<number>("discovery.filesPerSecond"),
    allowedFrom: get<string>("discovery.allowedFrom"),
    allowedUntil: get<string>("discovery.allowedUntil"),
    weekendsAnyTime: get<boolean>("discovery.weekendsAnyTime"),
    timeZone: get<string>("general.timeZone"),
    repassMs: env.DISCOVERY_REPASS_HOURS ? Number(env.DISCOVERY_REPASS_HOURS) * 3600_000 : get<number>("discovery.repassDays") * 86_400_000,
    maxFileBytes: get<number>("discovery.maxFileMb") * 1024 * 1024,
    fileTypes: new Set(get<string[]>("discovery.fileTypes")),
    exclude: excludeGlobs.map(globToRegExp),
  };
}
