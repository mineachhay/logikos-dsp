import { useCallback, useEffect, useState } from "react";

/**
 * A view's filters live in the URL after "?" (#/file-events?user=CORP%5Calice),
 * so a filtered view can be linked to, a link from another page opens it
 * already filtered, and a refresh keeps it. Changes replace the history entry
 * rather than adding one per keystroke.
 */
function read(): Record<string, string> {
  const query = window.location.hash.split("?")[1] ?? "";
  return Object.fromEntries(new URLSearchParams(query));
}

export function useHashState<T extends Record<string, string>>(defaults: T): [T & Record<string, string>, (patch: Partial<Record<keyof T | string, string | undefined>>) => void] {
  const [values, setValues] = useState<Record<string, string>>(read);

  useEffect(() => {
    const onHash = () => setValues(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const update = useCallback((patch: Partial<Record<string, string | undefined>>) => {
    setValues((current) => {
      const next: Record<string, string> = { ...current };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "") delete next[k];
        else next[k] = v;
      }
      const base = window.location.hash.split("?")[0] || "#/";
      const qs = new URLSearchParams(next).toString();
      window.history.replaceState(null, "", `${base}${qs ? `?${qs}` : ""}`);
      return next;
    });
  }, []);

  return [{ ...defaults, ...values } as T & Record<string, string>, update];
}

/** A link to another view, filtered: href for <a>, so it also opens in a new tab. */
export function viewHref(slug: string, params: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  return `#/${slug}${qs ? `?${qs}` : ""}`;
}
