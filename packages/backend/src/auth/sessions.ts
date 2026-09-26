// Session lifetime rules, kept free of I/O so they can be unit tested.

/**
 * A session ends this long after its last renewal. The token used to carry no
 * expiry at all, so a leaked cookie worked until JWT_SECRET changed; 12 hours
 * covers a working day without a re-login.
 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * An active session's token is re-issued once it's this old, so "12 hours"
 * means 12 hours of inactivity rather than 12 hours from login — and the
 * re-issue costs one cookie write per quarter hour, not one per request.
 */
export const RENEW_AFTER_SECONDS = 15 * 60;

/** Whether a token issued at `iat` (seconds since epoch) should be re-issued now. */
export function needsRenewal(iat: number | undefined, nowMs: number): boolean {
  if (iat === undefined) return true;
  return nowMs / 1000 - iat >= RENEW_AFTER_SECONDS;
}

/**
 * Routes a user who must change their password may still use: enough to see
 * who they are, change it, and leave. Everything else answers 403 until then —
 * enforced server side, so it can't be skipped by not loading the dashboard.
 */
const ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED = new Set(["GET /auth/me", "POST /auth/password"]);

export function allowedWhilePasswordChangeRequired(method: string, routeUrl: string | undefined): boolean {
  return ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED.has(`${method} ${routeUrl ?? ""}`);
}
