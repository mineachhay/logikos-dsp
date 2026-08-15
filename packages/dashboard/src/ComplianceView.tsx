import { useMemo } from "react";
import { usePolling } from "./usePolling.js";
import type { ClassificationMatch } from "./api.js";

// This is a *data-discovery* lens over existing classification results —
// which pattern types were found, where, how often — not a certified
// compliance audit. Real compliance (retention policy enforcement, access
// control review, breach notification procedures, data-subject-request
// handling) needs controls this product doesn't implement; grouping matches
// by the regulatory scope they're conventionally associated with is a long
// way short of that, and this view says so up front rather than implying
// otherwise. Two groups only, deliberately not stretched across every named
// regulation: PCI-DSS's scope (payment card data) is well-defined by pattern
// type alone, but GDPR vs. CCPA vs. HIPAA mostly turn on *who* the data
// subject is and *what sector* you're in, not which of SSN/email/phone/name
// was matched — presenting those as cleanly separable from pattern type
// alone would be a false precision this view isn't going to manufacture.
const FRAMEWORKS: { name: string; description: string; patternTypes: string[] }[] = [
  {
    name: "PCI-DSS scope",
    description: "Payment card data — the one regulatory scope pattern type alone actually distinguishes cleanly.",
    patternTypes: ["CREDIT_CARD"],
  },
  {
    name: "General personal data (GDPR / CCPA / similar)",
    description: "Identifiable personal information — which specific regulation applies depends on the data subject and sector, not on which pattern matched.",
    patternTypes: ["SSN", "EMAIL", "PHONE", "PERSON", "LOCATION", "ORGANIZATION"],
  },
];

function FrameworkCard({
  name,
  description,
  matches,
}: {
  name: string;
  description: string;
  matches: ClassificationMatch[];
}) {
  const distinctPaths = useMemo(() => new Set(matches.map((m) => m.path)), [matches]);
  const recent = useMemo(
    () => [...matches].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8),
    [matches],
  );

  return (
    <div className="chart-card">
      <div className="chart-card-head"><h3>{name}</h3></div>
      <p className="framework-desc">{description}</p>
      <div className="framework-stats">
        <div><span className="stat-value-sm">{matches.length}</span> match{matches.length === 1 ? "" : "es"}</div>
        <div><span className="stat-value-sm">{distinctPaths.size}</span> file{distinctPaths.size === 1 ? "" : "s"}</div>
      </div>
      {matches.length === 0 ? (
        <p className="empty">None found.</p>
      ) : (
        <table className="chart-table">
          <thead><tr><th>Pattern</th><th>Path</th><th>Found at</th></tr></thead>
          <tbody>
            {recent.map((m) => (
              <tr key={m.id}>
                <td>{m.patternType}</td>
                <td className="path">{m.path}</td>
                <td>{new Date(m.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {matches.length > recent.length && (
        <p className="framework-more">+{matches.length - recent.length} more — see Data Risk for the full list.</p>
      )}
    </div>
  );
}

export default function ComplianceView() {
  const { data, error } = usePolling<ClassificationMatch[]>("/classification-matches?limit=500", 10000);

  if (error) return <p className="error">Failed to load classification matches: {error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <div className="overview">
      <p className="compliance-disclaimer">
        This groups sensitive-data matches by the regulatory scope they're conventionally associated with — it's a
        discovery lens over what the classification worker has already found, not a certified compliance audit.
        Real compliance also needs retention-policy enforcement, access-control review, and breach-notification
        procedures, none of which this product implements yet.
      </p>
      <div className="overview-grid">
        {FRAMEWORKS.map((fw) => (
          <FrameworkCard
            key={fw.name}
            name={fw.name}
            description={fw.description}
            matches={data.filter((m) => fw.patternTypes.includes(m.patternType))}
          />
        ))}
      </div>
    </div>
  );
}
