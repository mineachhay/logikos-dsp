import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUNDLE_FILE_PATTERN,
  DUMP_FILE_PATTERN,
  bundleFileName,
  dumpFileName,
  selectForRetention,
} from "@logikos-dsp/shared";
import { run } from "./exec.js";
import { RESTORE_README, describeRcloneError, evaluateRestore, pgEnvFromUrl, shortMessage, type TableCounts } from "./pure.js";
import { buildRcloneSetup, withConfigDir, type DestinationInput } from "./rcloneConfig.js";
import type { WorkerConfig } from "./config.js";

const HOUR = 3600_000;

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** A private temp dir, removed however the callback ends. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "dsp-backup-"));
  await chmod(dir, 0o700);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes this run's rclone config (and known_hosts) into `dir` and returns a runner bound to it. */
async function rcloneIn(dir: string, destination: DestinationInput) {
  // rclone refuses a plain password in its config for both SFTP and SMB, so
  // whichever of them is in use gets obscured first.
  const password =
    (destination.type === "SFTP" && !destination.credentials.privateKey) || destination.type === "SMB"
      ? destination.credentials.password
      : undefined;
  const obscured = password ? (await run("rclone", ["obscure", "-"], { stdin: password })).stdout.trim() : undefined;
  const setup = buildRcloneSetup(destination, obscured);
  const configPath = path.join(dir, "rclone.conf");
  for (const [name, content] of Object.entries(setup.files)) {
    await writeFile(path.join(dir, name), content, { mode: 0o600 });
  }
  await writeFile(configPath, withConfigDir(setup, dir), { mode: 0o600 });
  const rclone = (args: string[], opts: { stdin?: string; timeoutMs?: number } = {}) =>
    run("rclone", ["--config", configPath, "--retries", "3", "--low-level-retries", "10", ...args], {
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
      stdin: opts.stdin,
    }).catch((err: Error) => {
      throw new Error(describeRcloneError(err.message.replace(/^rclone exited \d+: /, "")));
    });
  return { rclone, remoteDir: setup.remoteDir };
}

async function listRemote(rclone: Awaited<ReturnType<typeof rcloneIn>>["rclone"], remoteDir: string) {
  try {
    const { stdout } = await rclone(["lsjson", "--files-only", remoteDir]);
    return JSON.parse(stdout) as { Name: string; Size: number; ModTime: string }[];
  } catch (err) {
    // A folder that doesn't exist yet is just an empty destination.
    if (/directory not found|doesn't exist|no such file/i.test((err as Error).message)) return [];
    throw err;
  }
}

/** Writes, lists and deletes a small file — proves credentials, path and permissions without a real backup. */
export async function testDestination(destination: DestinationInput): Promise<string> {
  return withTempDir(async (dir) => {
    const { rclone, remoteDir } = await rcloneIn(dir, destination);
    const name = `.logikos-dsp-write-test-${Date.now()}`;
    await rclone(["rcat", `${remoteDir}/${name}`], { stdin: "logikos-dsp destination test\n", timeoutMs: 120_000 });
    const listing = await listRemote(rclone, remoteDir);
    if (!listing.some((f) => f.Name === name)) throw new Error("wrote a test file but couldn't list it back");
    await rclone(["deletefile", `${remoteDir}/${name}`], { timeoutMs: 120_000 });
    const existing = listing.filter((f) => BUNDLE_FILE_PATTERN.test(f.Name)).length;
    return `wrote, listed and deleted a test file in ${remoteDir} — ${existing} existing backup(s) there`;
  });
}

export interface BackupResult {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  message: string;
}

/**
 * The whole backup: dump locally (kept, for restore.sh), then bundle the dump
 * with the secret files and a manifest, encrypt it to the age recipient,
 * upload, and apply retention on both sides.
 */
export async function runBackup(
  cfg: WorkerConfig,
  destination: DestinationInput,
  agePublicKey: string,
  retention: { local: number; remote: number },
): Promise<BackupResult> {
  const now = new Date();
  const pgEnv = pgEnvFromUrl(cfg.databaseUrl);
  await mkdir(cfg.backupDir, { recursive: true });

  // 1. Dump to a .partial name, and only rename once pg_restore can read it
  //    back — a truncated dump must never look like a good one (same rule as
  //    deploy/backup.sh).
  const dumpName = dumpFileName(now);
  const dumpPath = path.join(cfg.backupDir, dumpName);
  const partial = `${dumpPath}.partial`;
  await run("pg_dump", ["-Fc", "--no-owner", "-f", partial], { env: pgEnv, timeoutMs: 2 * HOUR });
  await run("pg_restore", ["--list", partial], { timeoutMs: 10 * 60_000 });
  await rename(partial, dumpPath);

  return withTempDir(async (dir) => {
    // 2. Bundle: dump + secrets + manifest + restore notes.
    const staging = path.join(dir, "bundle");
    await mkdir(staging, { mode: 0o700 });
    await copyFile(dumpPath, path.join(staging, "logikos_dsp.dump"));
    const included: { name: string; sizeBytes: number; sha256: string }[] = [];
    const skipped: string[] = [];
    for (const f of cfg.secretFiles) {
      try {
        await copyFile(f.path, path.join(staging, f.name));
      } catch {
        skipped.push(`${f.name} (${f.path} not readable)`);
      }
    }
    for (const name of await readdir(staging)) {
      const p = path.join(staging, name);
      included.push({ name, sizeBytes: (await stat(p)).size, sha256: await sha256(p) });
    }
    const { stdout: pgVersion } = await run("pg_dump", ["--version"]);
    await writeFile(path.join(staging, "RESTORE.txt"), RESTORE_README);
    await writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify({ format: 1, createdAt: now.toISOString(), database: pgEnv.PGDATABASE, pgDump: pgVersion.trim(), files: included, skipped }, null, 2),
    );

    // 3. Encrypt. Only the public key is here, so this server can make
    //    backups but can never read them back.
    const tarPath = path.join(dir, "bundle.tar");
    const fileName = bundleFileName(now);
    const bundlePath = path.join(dir, fileName);
    await run("tar", ["-cf", tarPath, "-C", staging, "."], { timeoutMs: HOUR });
    await run("age", ["-r", agePublicKey, "-o", bundlePath, tarPath], { timeoutMs: HOUR });
    await rm(tarPath);
    const size = (await stat(bundlePath)).size;
    const digest = await sha256(bundlePath);

    // 4. Upload, and check it's really there at the right size. If upload
    //    fails the local dump is still good, so say so.
    const { rclone, remoteDir } = await rcloneIn(dir, destination);
    await rclone(["copyto", bundlePath, `${remoteDir}/${fileName}`], { timeoutMs: 4 * HOUR }).catch((err: Error) => {
      throw new Error(`upload failed: ${err.message} — the local dump ${dumpName} was still written`);
    });
    const listing = await listRemote(rclone, remoteDir);
    const uploaded = listing.find((f) => f.Name === fileName);
    if (!uploaded || uploaded.Size !== size) {
      throw new Error(`uploaded ${fileName} but the destination reports ${uploaded ? `${uploaded.Size} bytes, expected ${size}` : "no such file"}`);
    }

    // 5. Retention — only on files matching our own naming, on each side.
    const remoteDeletes = selectForRetention(listing.map((f) => f.Name), BUNDLE_FILE_PATTERN, retention.remote);
    for (const name of remoteDeletes) await rclone(["deletefile", `${remoteDir}/${name}`]);
    const localDeletes = selectForRetention(await readdir(cfg.backupDir), DUMP_FILE_PATTERN, retention.local);
    for (const name of localDeletes) await rm(path.join(cfg.backupDir, name), { force: true });

    const notes = [
      `uploaded ${fileName} (${size} bytes) to ${remoteDir}`,
      `bundle: ${included.map((f) => f.name).join(", ")}`,
      skipped.length ? `skipped: ${skipped.join(", ")}` : "",
      remoteDeletes.length || localDeletes.length ? `retention removed ${remoteDeletes.length} remote, ${localDeletes.length} local` : "",
    ].filter(Boolean);
    return { fileName, sizeBytes: size, sha256: digest, message: notes.join("; ") };
  });
}

async function tableCounts(pgEnv: Record<string, string>, database: string): Promise<TableCounts> {
  const sql =
    "SELECT string_agg(format('%s=%s', table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text), ',') " +
    "FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'";
  const { stdout } = await run("psql", ["-X", "-A", "-t", "-d", database, "-c", sql], { env: pgEnv, timeoutMs: 10 * 60_000 });
  const counts: TableCounts = {};
  for (const pair of stdout.trim().split(",").filter(Boolean)) {
    const [table, count] = pair.split("=");
    counts[table] = Number(count);
  }
  return counts;
}

/**
 * The weekly restore check: restore the newest local dump into a scratch
 * database and compare it with the live one, then confirm the newest bundle
 * is on the destination at the size recorded when it was uploaded. The
 * encrypted bundle itself can't be test-decrypted here — by design, the
 * private key isn't on this server.
 */
export async function runRestoreCheck(
  cfg: WorkerConfig,
  destination: DestinationInput | null,
  lastUpload: { fileName: string; sizeBytes: number } | null,
): Promise<string> {
  const pgEnv = pgEnvFromUrl(cfg.databaseUrl);
  const dumps = (await readdir(cfg.backupDir).catch(() => [])).filter((n) => DUMP_FILE_PATTERN.test(n)).sort();
  const newest = dumps.at(-1);
  if (!newest) throw new Error(`no local dump in ${cfg.backupDir} to check`);

  const scratch = "logikos_dsp_restore_check";
  const adminEnv = { ...pgEnv, PGDATABASE: "postgres" };
  await run("dropdb", ["--if-exists", scratch], { env: adminEnv });
  await run("createdb", [scratch], { env: adminEnv });
  let local: string;
  try {
    await run("pg_restore", ["--no-owner", "-d", scratch, path.join(cfg.backupDir, newest)], { env: pgEnv, timeoutMs: 2 * HOUR });
    const [restored, live] = await Promise.all([tableCounts(pgEnv, scratch), tableCounts(pgEnv, pgEnv.PGDATABASE)]);
    const verdict = evaluateRestore(restored, live);
    if (!verdict.ok) throw new Error(`${newest}: ${verdict.summary}`);
    local = `${newest}: ${verdict.summary}`;
  } finally {
    await run("dropdb", ["--if-exists", scratch], { env: adminEnv }).catch(() => undefined);
  }

  if (!destination || !lastUpload) return `${local}; no uploaded backup to check yet`;
  const remote = await withTempDir(async (dir) => {
    const { rclone, remoteDir } = await rcloneIn(dir, destination);
    const found = (await listRemote(rclone, remoteDir)).find((f) => f.Name === lastUpload.fileName);
    if (!found) throw new Error(`${local}; but ${lastUpload.fileName} is missing from ${remoteDir}`);
    if (found.Size !== lastUpload.sizeBytes) {
      throw new Error(`${local}; but ${lastUpload.fileName} is ${found.Size} bytes on the destination, ${lastUpload.sizeBytes} when uploaded`);
    }
    return `${lastUpload.fileName} present on the destination at its uploaded size`;
  });
  return shortMessage(`${local}; ${remote}`);
}
