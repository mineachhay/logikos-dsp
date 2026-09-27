import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { settingsApi } from "./api.js";
import type { SettingView } from "./api.js";
import { setDateConventions } from "./format.js";

type Values = Record<string, unknown>;

const SettingsContext = createContext<{ values: Values; settings: SettingView[]; apply: (settings: SettingView[]) => void }>({
  values: {},
  settings: [],
  apply: () => {},
});

/**
 * Loads the settings once after sign-in, so the header, dates and form
 * defaults use them from the first paint. The Settings page hands every save's
 * result back through `apply`, so a change shows everywhere without a reload.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingView[] | null>(null);

  const apply = useCallback((next: SettingView[]) => {
    const values = Object.fromEntries(next.map((s) => [s.key, s.value]));
    setDateConventions({ locale: values["general.dateFormat"] as string, timeZone: values["general.timeZone"] as string });
    setSettings(next);
  }, []);

  useEffect(() => {
    // Built-in defaults stand in if the server can't be asked — the dashboard still works.
    settingsApi.get().then((r) => apply(r.settings)).catch(() => setSettings([]));
  }, [apply]);

  if (!settings) return null;
  const values = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  return <SettingsContext.Provider value={{ values, settings, apply }}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}

/** One setting's current value, or `fallback` while unknown. */
export function useSetting<T>(key: string, fallback: T): T {
  const v = useSettings().values[key];
  return v === undefined ? fallback : (v as T);
}
