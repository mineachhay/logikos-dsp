import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

/**
 * Client-side sort — every table view already fetches its full working
 * set in one call (usePolling's limit=100-500), so sorting/filtering that
 * array in the browser is simpler than adding sort params to four backend
 * routes for data volumes this small. Revisit if a view's row count grows
 * past what's comfortable to ship in one response.
 *
 * `rankMaps` covers *ordinal* string fields (severity, status) where the
 * meaningful order isn't alphabetical — LOW/MEDIUM/HIGH/CRITICAL sorted as
 * plain strings comes out CRITICAL, HIGH, LOW, MEDIUM, which looks
 * plausible enough at a glance to ship by accident (this shipped once,
 * caught by actually clicking the header and looking, not by review).
 * Any field without a rank map falls back to numeric or string comparison.
 */
export function useSort<T>(
  data: T[] | null,
  initialKey: keyof T,
  initialDir: SortDir = "desc",
  rankMaps: Partial<Record<keyof T, Record<string, number>>> = {},
) {
  const [key, setKey] = useState<keyof T>(initialKey);
  const [dir, setDir] = useState<SortDir>(initialDir);

  const sorted = useMemo(() => {
    if (!data) return null;
    const copy = [...data];
    const rankMap = rankMaps[key];
    copy.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let cmp: number;
      if (rankMap && typeof av === "string" && typeof bv === "string") cmp = (rankMap[av] ?? 0) - (rankMap[bv] ?? 0);
      else if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
    return copy;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rankMaps is a per-render literal at call sites; keying off `key`/`dir`/`data` is what actually matters here
  }, [data, key, dir]);

  function toggleSort(k: keyof T) {
    if (k === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setKey(k);
      setDir("asc");
    }
  }

  return { sorted, sortKey: key, sortDir: dir, toggleSort };
}

export function SortableHeader<T>({
  label,
  columnKey,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  columnKey: keyof T;
  sortKey: keyof T;
  sortDir: SortDir;
  onSort: (k: keyof T) => void;
}) {
  const active = columnKey === sortKey;
  return (
    <th className="sortable" onClick={() => onSort(columnKey)}>
      {label}
      <span className={`sort-arrow ${active ? "active" : ""}`}>{active && sortDir === "asc" ? "▲" : "▼"}</span>
    </th>
  );
}

/**
 * One left-aligned row above the table — search box, optional select
 * filters, export pinned to the right — per the dataviz skill's filter
 * placement rule (filters are standard UI, not chart marks, but the same
 * "one row, scopes everything below it" composition applies to a filtered
 * table).
 */
export function TableToolbar({
  search,
  onSearch,
  searchPlaceholder = "Search…",
  filters,
  onExport,
  resultCount,
}: {
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder?: string;
  filters?: React.ReactNode;
  onExport: () => void;
  resultCount: number;
}) {
  return (
    <div className="table-toolbar">
      <input
        type="text"
        className="search-input"
        placeholder={searchPlaceholder}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      {filters}
      <span className="result-count">{resultCount.toLocaleString()} row{resultCount === 1 ? "" : "s"}</span>
      <button className="export-button" onClick={onExport} disabled={resultCount === 0}>
        Export CSV
      </button>
    </div>
  );
}
