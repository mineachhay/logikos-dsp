import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest for stored secrets: file-server passwords
 * (FileServer.passwordEnc) and backup destination credentials
 * (BackupSettings.credentialsEnc). Shared by the backend and the backup
 * worker. A separate entry point (`@logikos-dsp/shared/credentials`), not
 * re-exported from index.ts, because it needs node:crypto.
 *
 * AES-256-GCM with a random 12-byte IV per value; GCM's tag means a tampered
 * or wrong-key ciphertext fails to decrypt rather than yielding garbage.
 * Stored as `v1:<iv>:<tag>:<ciphertext>` (base64), the version prefix leaving
 * room for key rotation later.
 *
 * The key (SOURCE_CREDENTIALS_KEY, 32 bytes as base64 or hex) lives only in the
 * backend's env, never in the database — so a database dump alone doesn't
 * reveal share passwords, and conversely a restored dump is useless for
 * scanning without the key. Back it up separately.
 */

const VERSION = "v1";

function parseKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error("SOURCE_CREDENTIALS_KEY environment variable is required (32 bytes: `openssl rand -base64 32`)");
  }
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(`SOURCE_CREDENTIALS_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

export function requireCredentialsKey(): void {
  parseKey(process.env.SOURCE_CREDENTIALS_KEY);
}

export function encryptSecret(plaintext: string, rawKey = process.env.SOURCE_CREDENTIALS_KEY): string {
  const key = parseKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(stored: string, rawKey = process.env.SOURCE_CREDENTIALS_KEY): string {
  const key = parseKey(rawKey);
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("unrecognized encrypted secret format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
