import { fmtDateTime } from "./format.js";
import { usePolling } from "./usePolling.js";

interface Coverage {
  sourceId: string;
  name: string;
  rootLabel: string;
  totalFiles: number | null;
  candidates: number | null;
  skippedType: number | null;
  skippedSize: number | null;
  examined: number;
  noText: number;
  pendingClassification: number;
  filesWithSensitiveData: number;
  passStartedAt: string | null;
  passFinishedAt: string | null;
}

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString();

/**
 * How much of each share content discovery has actually examined. Shown above
 * Data Risk and Compliance because "0 matches" used to be read as "nothing
 * sensitive" when the truth was "nothing examined" — 3 files out of ~73,000.
 */
export default function DiscoveryCoverage() {
  const { data } = usePolling<Coverage[]>("/content-discovery/coverage", 15_000);
  if (!data) return null;
  if (data.length === 0) {
    return (
      <section className="fs-card coverage-card">
        <h3>What has been examined</h3>
        <p className="muted">
          No share has been examined yet. Content discovery starts after a share's first scan and reads each file's text
          slowly in the background; results appear here as it goes.
        </p>
      </section>
    );
  }
  return (
    <section className="fs-card coverage-card">
      <h3>What has been examined</h3>
      {data.map((c) => {
        const candidates = c.candidates ?? 0;
        const pct = candidates ? Math.min(100, Math.round((c.examined / candidates) * 100)) : 0;
        const state = c.passFinishedAt ? `pass finished ${fmtDateTime(c.passFinishedAt)}` : c.passStartedAt ? "examining…" : "waiting for the first scan";
        return (
          <div key={c.sourceId} className="coverage-row">
            <div className="coverage-head">
              <strong>{c.name}</strong>
              <span className="muted">{state}</span>
            </div>
            <div className="coverage-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${pct}%` }} />
            </div>
            <div className="coverage-figures">
              <span>
                <strong>{n(c.examined)}</strong> of {n(candidates)} readable files examined ({pct}%)
              </span>
              <span className="muted">
                {n(c.totalFiles)} files in all · {n(c.skippedType)} of other types or skipped by rule (images, archives, old .doc/.xls, Settings → Content discovery) · {n(c.skippedSize)} too
                large · {n(c.noText)} with no text (e.g. scanned PDFs)
                {c.pendingClassification > 0 && ` · ${n(c.pendingClassification)} waiting to be classified`}
              </span>
              <span className={c.filesWithSensitiveData ? "test-warn" : "muted"}>
                {n(c.filesWithSensitiveData)} file{c.filesWithSensitiveData === 1 ? "" : "s"} with sensitive data so far
              </span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
