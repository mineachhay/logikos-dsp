// Rules for a *new* password (create, reset, change). Logging in with an
// existing password is never checked against these, so tightening them
// doesn't lock anyone out — it applies the next time a password is set.

export const MIN_PASSWORD_LENGTH = 12;

/**
 * bcrypt only uses the first 72 bytes and silently ignores the rest, so a
 * longer passphrase would be weaker than it looks — refuse it rather than
 * pretend. Bytes, not characters: non-ASCII characters take 2-4 each.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Passwords that are always guessed first. Not a breach list (that would mean
 * shipping or querying one) — just the handful that meet the length rule and
 * would still fall to the first page of any wordlist.
 */
const COMMON = new Set(
  [
    "password1234",
    "password12345",
    "password123!",
    "passw0rd1234",
    "123456789012",
    "1234567890ab",
    "qwertyuiop12",
    "qwerty123456",
    "administrator",
    "administrator1",
    "admin1234567",
    "welcome12345",
    "letmein12345",
    "changeme1234",
    "iloveyou1234",
    "p@ssw0rd1234",
    "p@ssword1234",
  ].map((p) => p.toLowerCase()),
);

/** Why `password` isn't acceptable for `email`, or null if it is. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return `use at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} plain letters) — longer is silently truncated`;
  }
  const lower = password.toLowerCase();
  const name = email.split("@")[0]?.toLowerCase() ?? "";
  if (name.length >= 3 && lower.includes(name)) return "don't include your email name in the password";
  if (COMMON.has(lower)) return "that password is too common";
  if (new Set(lower).size <= 2) return "use more than one or two different characters";
  return null;
}

/** Emails are stored and compared lowercase, so Admin@x and admin@x are one account. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
