import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "./api.js";

/**
 * A long list read newest-first: the first page is polled (new rows appear on
 * their own), older pages are fetched once with a cursor on "Load more".
 * Filters go to the server as `query`; changing them starts over.
 */
export function usePagedFeed<T extends { id: string }>(
  path: string | null,
  query: Record<string, string | undefined>,
  timeOf: (row: T) => string,
  { pageSize = 100, pollMs = 5000 }: { pageSize?: number; pollMs?: number } = {},
) {
  const qs = useMemo(
    () => new URLSearchParams(Object.entries({ ...query, limit: String(pageSize) }).filter((e): e is [string, string] => Boolean(e[1]))).toString(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(query), pageSize],
  );
  const key = path ? `${path}?${qs}` : null;
  const [head, setHead] = useState<T[] | null>(null);
  const [older, setOlder] = useState<T[]>([]);
  const [olderFull, setOlderFull] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const current = useRef(key);

  useEffect(() => {
    current.current = key;
    setHead(null);
    setOlder([]);
    setOlderFull(null);
    setError(null);
    if (!key) return;
    let cancelled = false;
    const load = () =>
      fetchJson<T[]>(key)
        .then((rows) => {
          if (!cancelled) {
            setHead(rows);
            setError(null);
          }
        })
        .catch((err: Error) => !cancelled && setError(err.message));
    load();
    const id = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key, pollMs]);

  const rows = useMemo(() => {
    if (!head) return null;
    const seen = new Set<string>();
    const out: T[] = [];
    for (const r of [...head, ...older]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out.sort((a, b) => timeOf(b).localeCompare(timeOf(a)) || b.id.localeCompare(a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head, older]);

  const exhausted = head !== null && (olderFull === null ? head.length < pageSize : !olderFull);

  const loadMore = useCallback(async () => {
    if (!rows?.length || !key || exhausted) return;
    const last = rows[rows.length - 1]!;
    setLoadingMore(true);
    try {
      const page = await fetchJson<T[]>(`${key}&cursor=${encodeURIComponent(`${timeOf(last)}_${last.id}`)}`);
      if (current.current !== key) return;
      setOlder((o) => [...o, ...page]);
      setOlderFull(page.length >= pageSize);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, key, exhausted, pageSize]);

  /** The oldest time loaded — below it, rows may exist that aren't fetched yet. */
  const oldest = rows && rows.length ? timeOf(rows[rows.length - 1]!) : null;
  return { rows, error, exhausted, loadMore, loadingMore, oldest };
}
