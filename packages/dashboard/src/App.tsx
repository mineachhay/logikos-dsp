import { fmtDateTime } from "./format.js";
import { useEffect, useMemo, useState } from "react";
import AlertsView from "./AlertsView.js";
import FileEventsView from "./FileEventsView.js";
import { usePolling } from "./usePolling.js";
import { sourceName, patternLabel } from "./api.js";
import type { ClassificationMatch } from "./api.js";
import { AuthProvider, useAuth } from "./auth.js";
import LoginView from "./LoginView.js";
import UsersView from "./UsersView.js";
import AccountView from "./AccountView.js";
import BackupWarning from "./BackupWarning.js";
import CertificateWarning from "./CertificateWarning.js";
import SettingsView from "./SettingsView.js";
import { SettingsProvider, useSetting } from "./settingsContext.js";
import StorageView from "./StorageView.js";
import DiscoveryCoverage from "./DiscoveryCoverage.js";
import AgentsView from "./AgentsView.js";
import FileServersView from "./FileServersView.js";
import BackupsView from "./BackupsView.js";
import RetentionView from "./RetentionView.js";
import FileAccessView from "./FileAccessView.js";
import OverviewView from "./OverviewView.js";
import ComplianceView from "./ComplianceView.js";
import { downloadCsv } from "./csv.js";
import { useHashState } from "./hashState.js";
import { useSort, SortableHeader, TableToolbar } from "./tableControls.js";

// Grouped to mirror ManageEngine DataSecurity Plus's module-based sidebar
// (File Audit / Data Risk Assessment / Disk Analysis, each with its own
// sub-nav) rather than force an exact 1:1 mapping onto module names that
// don't quite fit this product's data model — logikos-dsp's Alerts view
// covers both ransomware-rate and sensitive-data alerts together rather
// than splitting into a separate "Ransomware Protection" module, so the
// grouping below reflects what this product actually has, not DataSecurity
// Plus's exact taxonomy.
const NAV_GROUPS: { label: string | null; items: readonly string[] }[] = [
  { label: null, items: ["Overview"] },
  { label: "File Audit", items: ["Alerts", "File Events", "File Access"] },
  { label: "Data Risk Assessment", items: ["Data Risk", "Compliance"] },
  { label: "Disk Analysis", items: ["Storage"] },
];

/**
 * The current view lives in the URL hash, so a refresh stays where you were,
 * the browser's back button works, and a link to a page can be sent to
 * someone. The hash rather than a path because the dashboard is served as a
 * static bundle: any other path would need the web server taught to fall back
 * to index.html, and getting that wrong turns a refresh into a 404.
 */
function tabToSlug(tab: string): string {
  return tab.toLowerCase().replace(/\s+/g, "-");
}

function slugToTab(slug: string, available: readonly string[]): string | null {
  // A view can take options after "?" (#/settings?section=system); they don't pick the view.
  const wanted = slug.replace(/^#\/?/, "").split("?")[0]!;
  return available.find((tab) => tabToSlug(tab) === wanted) ?? null;
}

function DataRiskView() {
  const { data, error } = usePolling<ClassificationMatch[]>("/classification-matches?limit=100", 5000);
  const [search, setSearch] = useState("");
  // In the URL, so Overview's chart can link straight to one kind of match.
  const [hash, setHash] = useHashState({ pattern: "" } as Record<string, string>);
  const patternFilter = hash.pattern ?? "";
  const setPatternFilter = (pattern: string) => setHash({ pattern });

  const filtered = useMemo(() => {
    if (!data) return null;
    const q = search.trim().toLowerCase();
    return data.filter((m) => {
      if (patternFilter && patternLabel(m) !== patternFilter) return false;
      if (q && !`${m.path} ${m.source ? sourceName({ source: m.source }) : ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, search, patternFilter]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort<ClassificationMatch>(filtered, "createdAt", "desc");
  const patternTypes = useMemo(() => Array.from(new Set((data ?? []).map(patternLabel))).sort(), [data]);

  if (error) return <p className="error">Failed to load classification matches: {error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <>
      <DiscoveryCoverage />
      <TableToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search path…"
        resultCount={sorted?.length ?? 0}
        filters={
          <select value={patternFilter} onChange={(e) => setPatternFilter(e.target.value)}>
            <option value="">All patterns</option>
            {patternTypes.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        }
        onExport={() =>
          downloadCsv(
            "data-risk-matches.csv",
            ["Pattern", "Sample (redacted)", "Path", "Source", "Found by", "Found at"],
            (sorted ?? []).map((m) => [patternLabel(m), m.redactedSample, m.path, m.source ? sourceName({ source: m.source }) : "", m.foundBy === "discovery" ? "existing file" : "change", m.createdAt]),
          )
        }
      />
      {sorted && sorted.length === 0 ? (
        <p className="empty">No sensitive-data matches match your filters.</p>
      ) : (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortableHeader label="Pattern" columnKey="patternType" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th>Sample (redacted)</th>
              <SortableHeader label="Path" columnKey="path" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th>Source</th>
              <th>Found by</th>
              <SortableHeader label="Found at" columnKey="createdAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted!.map((m) => (
              <tr key={m.id}>
                <td data-label="Pattern">{patternLabel(m)}</td>
                <td data-label="Sample"><code>{m.redactedSample}</code></td>
                <td data-label="Path" className="path cell-wide">{m.path}</td>
                <td data-label="Source">{m.source ? sourceName({ source: m.source }) : "—"}</td>
                <td data-label="Found by" className="muted">{m.foundBy === "discovery" ? "existing file" : "change"}</td>
                <td data-label="Found at">{fmtDateTime(m.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

function Dashboard() {
  const { user, logout } = useAuth();
  const orgName = useSetting("general.orgName", "");
  // Viewers get Settings too, read-only: how the system is configured is theirs to see.
  const groups = useMemo(
    () =>
      user?.role === "ADMIN"
        ? [...NAV_GROUPS, { label: "Administration", items: ["File Servers", "Backups", "Retention", "Agents", "Users", "Settings"] }]
        : [...NAV_GROUPS, { label: null, items: ["Settings"] }],
    [user?.role],
  );
  // "My account" isn't in the sidebar — it's opened from the email in the top bar.
  const allTabs = useMemo(() => [...groups.flatMap((g) => g.items), "My account"], [groups]);
  // Read the hash on first render rather than in an effect, so the right view
  // is painted immediately instead of flashing Overview first.
  const [tab, setTab] = useState<string>(() => slugToTab(window.location.hash, allTabs) ?? "Overview");
  // Below 900px the sidebar is an off-canvas drawer (see index.css); on wider
  // screens it's always visible and this flag has no effect.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // Back and forward move between views, and a hash typed by hand works too.
  useEffect(() => {
    const onHashChange = () => setTab(slugToTab(window.location.hash, allTabs) ?? "Overview");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [allTabs]);

  // A VIEWER who follows an admin's link to, say, #/users would otherwise
  // land on a blank page: the tab isn't in their nav, so nothing renders.
  useEffect(() => {
    if (!allTabs.includes(tab)) {
      setTab("Overview");
      window.location.hash = "";
    }
  }, [allTabs, tab]);

  function selectTab(t: string) {
    setTab(t);
    setNavOpen(false);
    window.scrollTo(0, 0);
    // Pushes a history entry, so Back returns to the previous view.
    window.location.hash = `/${tabToSlug(t)}`;
  }

  return (
    <div className="app-shell">
      <aside id="app-nav" className={`sidebar ${navOpen ? "open" : ""}`}>
        <h1>logikos-dsp</h1>
        {orgName && <div className="sidebar-org">{orgName}</div>}
        <nav>
          {groups.map((g) => (
            <div className="nav-group" key={g.label ?? "root"}>
              {g.label && <div className="nav-group-label">{g.label}</div>}
              {g.items.map((t) => (
                <button key={t} className={t === tab ? "active" : ""} aria-current={t === tab ? "page" : undefined} onClick={() => selectTab(t)}>
                  {t}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <div className="main-column">
        <div className="topbar">
          <button
            className="nav-toggle"
            aria-label={navOpen ? "Close menu" : "Open menu"}
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((v) => !v)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <h2 className="topbar-title">{tab}</h2>
          <div className="session">
            <button className="session-email btn-link" title="My account — change password" onClick={() => selectTab("My account")}>
              {user?.email}
            </button>
            <button onClick={() => logout()}>Log out</button>
          </div>
        </div>
        {user?.role === "ADMIN" && <BackupWarning onOpen={() => selectTab("Backups")} />}
        {user?.role === "ADMIN" && <CertificateWarning onOpen={() => { window.location.hash = "/settings?section=system"; }} />}
        <main>
          {tab === "Overview" && <OverviewView />}
          {tab === "Alerts" && <AlertsView />}
          {tab === "File Events" && <FileEventsView />}
          {tab === "File Access" && <FileAccessView />}
          {tab === "Storage" && <StorageView />}
          {tab === "Data Risk" && <DataRiskView />}
          {tab === "Compliance" && <ComplianceView />}
          {tab === "File Servers" && <FileServersView />}
          {tab === "Backups" && <BackupsView />}
          {tab === "Retention" && <RetentionView />}
          {tab === "Agents" && <AgentsView />}
          {tab === "Users" && <UsersView />}
          {tab === "Settings" && <SettingsView />}
          {tab === "My account" && <AccountView />}
        </main>
      </div>
    </div>
  );
}

function AppShell() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <LoginView />;
  // After an admin reset the server allows nothing but the password change.
  return user.mustChangePassword ? (
    <AccountView forced />
  ) : (
    <SettingsProvider>
      <Dashboard />
    </SettingsProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
