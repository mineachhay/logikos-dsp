import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { viewHref } from "./hashState.js";

/**
 * The filter row the long lists share: search, time range, and (where the
 * list has them) account and folder. Everything here is sent to the server,
 * so it filters all history, not the rows on screen.
 */

export const RANGES: { value: string; label: string; ms: number | null }[] = [
  { value: "24h", label: "Last 24 hours", ms: 86_400_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
  { value: "all", label: "All time", ms: null },
  { value: "custom", label: "Custom range…", ms: null },
];

/** from/to for the query. Fixed when the range is picked, so polling doesn't move the window every few seconds. */
export function useRange(range: string, customFrom?: string, customTo?: string): { from?: string; to?: string } {
  return useMemo(() => {
    if (range === "custom") {
      const iso = (v?: string) => (v ? new Date(v).toISOString() : undefined);
      return { from: iso(customFrom), to: iso(customTo) };
    }
    const r = RANGES.find((x) => x.value === range);
    return r?.ms ? { from: new Date(Date.now() - r.ms).toISOString() } : {};
  }, [range, customFrom, customTo]);
}

/** A text box that reports after typing stops, so each keystroke isn't a query. */
export function DebouncedInput({ value, onChange, placeholder, className, ariaLabel }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; ariaLabel?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onChange(text.trim()), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return <input type="search" className={className ?? "search-input"} placeholder={placeholder} aria-label={ariaLabel ?? placeholder} value={text} onChange={(e) => setText(e.target.value)} />;
}

export function ListFilters({
  values,
  set,
  searchPlaceholder,
  withUser,
  withPath,
  children,
  summary,
  onExport,
  exportDisabled,
  defaultRange = "7d",
}: {
  values: Record<string, string>;
  set: (patch: Record<string, string | undefined>) => void;
  searchPlaceholder: string;
  withUser?: boolean;
  withPath?: boolean;
  children?: ReactNode;
  summary: ReactNode;
  onExport: () => void;
  exportDisabled?: boolean;
  defaultRange?: string;
}) {
  const range = values.range ?? defaultRange;
  const active = ["q", "user", "path"].filter((k) => values[k]).length + (range !== defaultRange ? 1 : 0);
  return (
    <div className="table-toolbar list-filters">
      <DebouncedInput value={values.q ?? ""} onChange={(q) => set({ q })} placeholder={searchPlaceholder} />
      <select value={range} onChange={(e) => set({ range: e.target.value })} aria-label="Time range">
        {RANGES.map((r) => (
          <option key={r.value} value={r.value}>{r.label}</option>
        ))}
      </select>
      {range === "custom" && (
        <span className="custom-range">
          <input type="datetime-local" value={values.from ?? ""} onChange={(e) => set({ from: e.target.value })} aria-label="From" />
          <span className="muted">to</span>
          <input type="datetime-local" value={values.to ?? ""} onChange={(e) => set({ to: e.target.value })} aria-label="To" />
        </span>
      )}
      {withUser && <DebouncedInput className="filter-input" value={values.user ?? ""} onChange={(user) => set({ user })} placeholder="Account, e.g. DOMAIN\user" />}
      {withPath && <DebouncedInput className="filter-input" value={values.path ?? ""} onChange={(path) => set({ path })} placeholder="Folder or file, e.g. 18_Roster/" />}
      {children}
      {active > 0 && (
        <button className="btn-link" onClick={() => set({ q: undefined, user: undefined, path: undefined, range: undefined, from: undefined, to: undefined })}>
          Clear filters
        </button>
      )}
      <span className="result-count">{summary}</span>
      <button className="export-button" onClick={onExport} disabled={exportDisabled}>
        Export CSV
      </button>
    </div>
  );
}

export function LoadMore({ exhausted, loadingMore, onMore, shown }: { exhausted: boolean; loadingMore: boolean; onMore: () => void; shown: number }) {
  if (shown === 0) return null;
  return (
    <div className="load-more">
      {exhausted ? (
        <span className="muted">That's everything in this range.</span>
      ) : (
        <button className="btn btn-secondary btn-sm" disabled={loadingMore} onClick={onMore}>
          {loadingMore ? "Loading…" : "Load older"}
        </button>
      )}
    </div>
  );
}

/** An account, as a link to everything it did in File Access. */
export function UserLink({ user, children }: { user: string; children?: ReactNode }) {
  return (
    <a className="cell-link" href={viewHref("file-access", { user, range: "7d" })} title={`Everything ${user} did (File Access)`}>
      {children ?? user}
    </a>
  );
}

/** A file or folder, as a link to its history in File Events (or everyone who touched it, in File Access). */
export function PathLink({ path, children, to = "file-events" }: { path: string; children?: ReactNode; to?: "file-events" | "file-access" }) {
  return (
    <a
      className="cell-link path-link"
      href={viewHref(to, { path, range: "30d" })}
      title={to === "file-events" ? "History of this file (File Events)" : "Everyone who touched this (File Access)"}
    >
      {children ?? path}
    </a>
  );
}
