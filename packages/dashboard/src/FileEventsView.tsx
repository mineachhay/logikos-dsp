import { useMemo } from "react";
import { collapseBursts, FromCell, fromText, RepeatBadge } from "./activityBursts.js";
import { sourceName } from "./api.js";
import type { FileEvent, FileActivityRow } from "./api.js";
import { fmtDate, fmtDateTime } from "./format.js";
import { downloadCsv } from "./csv.js";
import { useSort, SortableHeader } from "./tableControls.js";
import { useHashState } from "./hashState.js";
import { usePagedFeed } from "./usePagedFeed.js";
import { ListFilters, LoadMore, PathLink, UserLink, useRange } from "./ListFilters.js";
import { CHANGE_LABELS, changeLabel, formatBytes, sizeChange } from "./labels.js";

/**
 * Reads shown as timeline rows. Copying a file *out* of a share changes
 * nothing on it, so it can never be a file event — but it is what a read is,
 * and people look for it here. Windows records opening a file and copying it
 * identically, so the row says READ and the bulk-read alert is what calls a
 * burst of them a copy.
 */
/**
 * A drive letter is meaningless on its own — E: is whatever was plugged in
 * most recently — so a file that landed on removable media is marked, and
 * named by the device rather than the letter.
 */
function removableNote(event: FileEvent) {
  if (!event.removable) return null;
  const device = [event.volumeLabel, event.volumeSerial].filter(Boolean).join(" ");
  return <span className="badge badge-removable">USB{device ? ` · ${device}` : ""}</span>;
}

/**
 * Drops the reads that a copy already accounts for.
 *
 * At the file-server level a copy *is* a read: the client opens the file and
 * reads its bytes, and Windows records that identically to someone opening a
 * document to look at it — there is no flag distinguishing the two, which is
 * the whole reason an agent on the destination machine exists. So both rows
 * are true, but showing them together counts one action twice: copying five
 * files produced five COPIED rows and five READ rows saying the same thing.
 *
 * A read is considered explained when a copy in the same batch names it as
 * where it came from. Anything else — opening a document, a read whose
 * destination was never seen because the machine has no agent — stays, which
 * is what the timeline is for.
 */
function readsExplainedByCopies(events: FileEvent[]): Set<string> {
  const explained = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "COPIED" || !event.previousPath || !event.previousSource) continue;
    explained.add(`${event.previousSource.id}|${event.previousPath.toLowerCase()}`);
  }
  return explained;
}

/**
 * An audited actor and a file's owner are different claims, and the column
 * says which one it is showing. A local change carries no user at all — the
 * OS notification doesn't have one — so ownership is the only signal there is,
 * and it answers "whose file is this" rather than "who did this": it survives
 * a move, an administrator can change it, and it is sometimes a group.
 * Labelling it plainly is the difference between a record that can be relied
 * on and one that quietly overstates what is known.
 */
function whoDidIt(event: FileEvent) {
  if (event.actorUser) return <UserLink user={event.actorUser} />;
  if (event.ownerUser) {
    return (
      <span title="The file's owner, not an audited record of who made the change">
        {event.ownerUser} <span className="muted">(owner)</span>
      </span>
    );
  }
  // An empty cell reads as "nobody"; say why there's no name instead.
  switch (event.noActorReason) {
    case "before-audit":
      return (
        <span className="muted" title="The file server's audit records start after this change">
          no audit record{event.auditSince ? ` (collection started ${fmtDate(event.auditSince)})` : " (collection not started)"}
        </span>
      );
    case "audit-off":
      return <span className="muted" title="Turn on “Record who changes files” for this file server">audit off</span>;
    case "unmatched":
      return <span className="muted" title="No audit record matched this change's path and time">no matching record</span>;
    case "local":
      return <span className="muted" title="The operating system reports what changed, not who">not recorded</span>;
    default:
      return <span className="muted">—</span>;
  }
}

function readsAsEvents(reads: FileActivityRow[]): FileEvent[] {
  return collapseBursts(reads).map((r) => ({
    id: `read-${r.id}`,
    eventType: "READ",
    repeat: r.repeat,
    path: r.path,
    previousPath: null,
    previousSource: null,
    ownerUser: null,
    removable: false,
    volumeLabel: null,
    volumeSerial: null,
    sizeBytes: null,
    occurredAt: r.occurredAt,
    agent: { hostname: "", watchedRoot: "" },
    source: r.source,
    actorUser: r.userDomain ? `${r.userDomain}\\${r.userName}` : r.userName,
    actorIp: r.clientIp,
    actorHost: r.clientHost ?? null,
  }));
}


const readTime = (r: FileActivityRow) => r.occurredAt;
const eventTime = (e: FileEvent) => e.occurredAt;

export default function FileEventsView() {
  const [f, set] = useHashState({ range: "7d", reads: "1", temp: "hide" } as Record<string, string>);
  const { from, to } = useRange(f.range!, f.from, f.to);
  const common = { q: f.q, user: f.user, path: f.path, from, to };
  const wantEvents = f.type !== "READ";
  const wantReads = f.reads === "1" && (!f.type || f.type === "READ");
  const events = usePagedFeed<FileEvent>(wantEvents ? "/events" : null, { ...common, type: f.type, hideTemp: f.temp === "hide" ? "1" : "0" }, eventTime, { pollMs: 4000 });
  const reads = usePagedFeed<FileActivityRow>(wantReads ? "/file-activity" : null, { ...common, action: "READ" }, readTime);

  // Two lists merged by time: show rows only down to where both are loaded,
  // or a page of events could sit next to a gap in the reads.
  const feeds = [wantEvents && { feed: events, oldest: events.oldest }, wantReads && { feed: reads, oldest: reads.oldest }].filter(Boolean) as {
    feed: { exhausted: boolean; loadMore: () => void; loadingMore: boolean };
    oldest: string | null;
  }[];
  const cutoff = feeds.filter((x) => !x.feed.exhausted && x.oldest).reduce<string | null>((max, x) => (!max || x.oldest! > max ? x.oldest : max), null);
  const loading = (wantEvents && !events.rows) || (wantReads && !reads.rows);

  const combined = useMemo(() => {
    if (loading) return null;
    const changes = wantEvents ? events.rows! : [];
    let rows: FileEvent[] = changes;
    if (wantReads) {
      const explained = readsExplainedByCopies(changes);
      const unexplained = reads.rows!.filter((r) => !explained.has(`${r.source?.id ?? ""}|${r.path.toLowerCase()}`));
      rows = [...changes, ...readsAsEvents(unexplained)];
    }
    return cutoff ? rows.filter((r) => r.occurredAt >= cutoff) : rows;
  }, [loading, wantEvents, wantReads, events.rows, reads.rows, cutoff]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort<FileEvent>(combined, "occurredAt", "desc");
  const error = events.error ?? reads.error;

  if (error && !combined) return <p className="error">Failed to load events: {error}</p>;
  if (!combined) return <p>Loading…</p>;
  const exhausted = feeds.every((x) => x.feed.exhausted);

  return (
    <>
      <p className="muted view-note">
        Changes to watched folders, plus <strong>reads</strong> where the file server records them. A read whose destination an agent saw is shown
        as the copy it was; every read is in File Access. Click an account or a path for its history.
      </p>
      <ListFilters
        values={f}
        set={set}
        withUser
        withPath
        searchPlaceholder="Search path, account, PC…"
        summary={`${combined.length.toLocaleString()}${exhausted ? "" : "+"} row${combined.length === 1 ? "" : "s"}`}
        exportDisabled={combined.length === 0}
        onExport={() =>
          downloadCsv(
            "file-events.csv",
            ["Type", "Path", "Size", "Previous size", "Source", "Who", "From", "When"],
            (sorted ?? []).map((e) => [
              changeLabel(e.eventType),
              e.previousPath ? `${e.previousPath} → ${e.path}` : e.path,
              e.sizeBytes ?? "",
              e.prevSizeBytes ?? "",
              sourceName(e),
              e.actorUser ?? "",
              fromText(e.actorHost, e.actorIp),
              e.occurredAt,
            ]),
          )
        }
      >
        <select value={f.type ?? ""} onChange={(e) => set({ type: e.target.value })} aria-label="Type">
          <option value="">All types</option>
          {Object.entries(CHANGE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <label className="inline-toggle">
          <input type="checkbox" checked={f.reads === "1"} onChange={(e) => set({ reads: e.target.checked ? "1" : "0" })} />
          reads
        </label>
        <label className="inline-toggle" title="Office creates ~$ lock files and ~WRL….tmp save files every time a document is opened or saved">
          <input type="checkbox" checked={f.temp !== "hide"} onChange={(e) => set({ temp: e.target.checked ? "show" : "hide" })} />
          Office temporary files
        </label>
      </ListFilters>
      {sorted && sorted.length === 0 ? (
        <p className="empty">No file events match — try a longer time range, or clear filters.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <SortableHeader label="Type" columnKey="eventType" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Path" columnKey="path" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Size" columnKey="sizeBytes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <th>Source</th>
                <SortableHeader label="Who" columnKey="actorUser" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="From" columnKey="actorHost" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="When" columnKey="occurredAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {sorted!.map((e) => {
                const delta = sizeChange(e.sizeBytes, e.prevSizeBytes);
                return (
                  <tr key={e.id}>
                    <td data-label="Type">
                      {changeLabel(e.eventType)}
                      {e.repeat && e.repeat > 1 && <RepeatBadge count={e.repeat} />}
                    </td>
                    <td data-label="Path" className="path cell-wide">
                      {e.previousPath ? (
                        <>
                          {/* A copy from somewhere else names that place, or the two paths look unrelated. */}
                          {e.previousSource && <span className="muted">{sourceName({ source: e.previousSource })}: </span>}
                          <PathLink path={e.previousPath} /> <span className="muted">{e.eventType === "COPIED" ? "⧉" : "→"}</span> <PathLink path={e.path} />
                          {removableNote(e)}
                        </>
                      ) : (
                        <>
                          <PathLink path={e.path} />
                          {removableNote(e)}
                        </>
                      )}
                    </td>
                    <td data-label="Size" title={e.sizeBytes != null ? `${e.sizeBytes.toLocaleString()} bytes` : undefined}>
                      {formatBytes(e.sizeBytes)}
                      {delta && <span className={`size-change ${delta.startsWith("+") ? "size-up" : "size-down"}`}>{delta}</span>}
                    </td>
                    <td data-label="Source" title={e.source?.rootLabel}>{sourceName(e)}</td>
                    <td data-label="Who">{whoDidIt(e)}</td>
                    <td data-label="From"><FromCell host={e.actorHost} ip={e.actorIp} /></td>
                    <td data-label="When" className="cell-time">{fmtDateTime(e.occurredAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <LoadMore
        exhausted={exhausted}
        loadingMore={feeds.some((x) => x.feed.loadingMore)}
        shown={combined.length}
        onMore={() => feeds.filter((x) => !x.feed.exhausted && x.oldest === cutoff).forEach((x) => x.feed.loadMore())}
      />
    </>
  );
}
