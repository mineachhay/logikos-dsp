import { usePolling } from "./usePolling.js";
import type { SystemHealth } from "./api.js";

/**
 * A bar across every page, for admins, when a certificate the system depends
 * on (the dashboard's own, or AD's LDAPS) expires within 30 days — the same
 * reasoning as BackupWarning: tucked away on a settings page, it wouldn't be
 * seen until sign-in or agents stopped working.
 */
export default function CertificateWarning({ onOpen }: { onOpen: () => void }) {
  const { data } = usePolling<SystemHealth>("/system/health", 30 * 60_000);
  const expiring = (data?.certificates ?? []).filter((c) => c.expiresAt && Date.parse(c.expiresAt) - Date.now() < 30 * 86_400_000);
  if (expiring.length === 0) return null;
  const soonest = Math.floor((Math.min(...expiring.map((c) => Date.parse(c.expiresAt!))) - Date.now()) / 86_400_000);
  return (
    <div className={`global-warning ${soonest <= 7 ? "warning-bad" : "warning-note"}`} role="alert">
      {soonest < 0 ? "A certificate has expired" : `A certificate expires in ${soonest} day${soonest === 1 ? "" : "s"}`}: {expiring.map((c) => `${c.name} (${c.host})`).join(", ")}.{" "}
      <button className="btn-link" onClick={onOpen}>
        Details
      </button>
    </div>
  );
}
