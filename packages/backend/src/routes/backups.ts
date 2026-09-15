import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import type { BackupRun, BackupSettings } from "@prisma/client";
import { z } from "zod";
import {
  S3_PROVIDERS,
  isAgeRecipient,
  nextDailySlot,
  nextVerifySlot,
  parseScheduleTime,
} from "@logikos-dsp/shared";
import { decryptSecret, encryptSecret } from "@logikos-dsp/shared/credentials";
import { prisma } from "../db.js";
import { recordAudit } from "../audit.js";

// The worker heartbeats every poll (15s); this much silence means it isn't running.
const WORKER_OFFLINE_AFTER_MS = 90_000;

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const s3Destination = z.object({
  type: z.literal("S3"),
  config: z
    .object({
      provider: z.enum(S3_PROVIDERS),
      endpoint: optionalTrimmed(500).refine((v) => !v || /^https?:\/\//.test(v), "endpoint must start with https:// (or http:// for a local MinIO)"),
      region: optionalTrimmed(100),
      bucket: trimmed(255).regex(/^[a-zA-Z0-9.\-_]+$/, "bucket name only — put folders in Remote folder"),
      accessKeyId: trimmed(256),
    })
    .refine((c) => c.provider === "AWS" || c.endpoint, { message: "endpoint is required for this provider", path: ["endpoint"] }),
  // Credential fields are all optional here: blank means "keep what's stored".
  // missingCredentials() checks that the merged result is complete.
  credentials: z.object({ secretAccessKey: optionalTrimmed(512) }).optional(),
});

const sftpDestination = z.object({
  type: z.literal("SFTP"),
  config: z.object({
    host: trimmed(253).regex(/^[A-Za-z0-9.\-:\[\]]+$/, "hostname or IP only"),
    port: z.number().int().min(1).max(65535).optional(),
    username: trimmed(128),
    hostKey: optionalTrimmed(8000),
  }),
  credentials: z.object({ password: optionalTrimmed(1024), privateKey: optionalTrimmed(16_000) }).optional(),
});

const gdriveDestination = z.object({
  type: z.literal("GDRIVE"),
  config: z
    .object({
      authMode: z.enum(["SERVICE_ACCOUNT", "OAUTH_TOKEN"]),
      rootFolderId: optionalTrimmed(200),
      sharedDriveId: optionalTrimmed(200),
    })
    .refine((c) => c.authMode !== "SERVICE_ACCOUNT" || c.sharedDriveId, {
      message: "a service account needs a Shared drive id — service accounts have no storage of their own",
      path: ["sharedDriveId"],
    }),
  credentials: z
    .object({
      serviceAccountJson: optionalTrimmed(20_000).refine((v) => !v || isJson(v), "service account key must be the JSON file's contents"),
      oauthTokenJson: optionalTrimmed(8000).refine((v) => !v || isJson(v), "token must be the JSON that `rclone authorize \"drive\"` prints"),
    })
    .optional(),
});

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  scheduleTimeUtc: z.string().refine((v) => parseScheduleTime(v) !== null, "time must be HH:MM (24h, UTC)"),
  verifyWeekday: z.number().int().min(0).max(6).nullable(),
  localRetention: z.number().int().min(1).max(365),
  remoteRetention: z.number().int().min(1).max(3650),
  remotePath: z
    .string()
    .trim()
    .max(300)
    .regex(/^[A-Za-z0-9._\-/ ]*$/, "letters, numbers, . _ - / and spaces only")
    .refine((v) => !v.split("/").includes(".."), "no .. in the remote folder")
    // A leading "/" is kept: it means an absolute path on an SFTP server. The
    // worker strips it for S3 and Google Drive, where paths are always relative.
    .transform((v) => v.replace(/\/+$/g, "")),
  agePublicKey: z
    .string()
    .trim()
    .nullable()
    .refine((v) => v === null || v === "" || isAgeRecipient(v), "not an age public key — it starts with age1 (paste the public key, never the AGE-SECRET-KEY line)")
    .transform((v) => (v ? v : null)),
  destination: z.discriminatedUnion("type", [s3Destination, sftpDestination, gdriveDestination]).nullable(),
});

const runRequestSchema = z.object({ kind: z.enum(["BACKUP", "VERIFY", "TEST_DESTINATION"]) });

/** Submitted secrets layered over stored ones; blank submitted fields don't erase what's stored. */
function mergeCredentials(stored: Record<string, string | undefined>, submitted: object | undefined): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...stored })) if (v) merged[k] = v;
  for (const [k, v] of Object.entries(submitted ?? {})) if (typeof v === "string" && v) merged[k] = v;
  return merged;
}

/** Which credential fields each destination type needs, given its config. */
function missingCredentials(destination: NonNullable<z.infer<typeof settingsSchema>["destination"]>, stored: Record<string, string | undefined>): string | null {
  const creds = mergeCredentials(stored, destination.credentials);
  switch (destination.type) {
    case "S3":
      return creds.secretAccessKey ? null : "secret access key is required";
    case "SFTP":
      return creds.password || creds.privateKey ? null : "a password or a private key is required";
    case "GDRIVE":
      if (destination.config.authMode === "SERVICE_ACCOUNT") return creds.serviceAccountJson ? null : "service account key JSON is required";
      return creds.oauthTokenJson ? null : "OAuth token JSON is required";
  }
}

async function getSettings(): Promise<BackupSettings> {
  return prisma.backupSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
}

function serializeRun(run: BackupRun) {
  return { ...run, sizeBytes: run.sizeBytes?.toString() ?? null };
}

function publicSettings(s: BackupSettings, lastSuccess: BackupRun | null) {
  const now = new Date();
  const credentialFields = s.credentialsEnc
    ? Object.entries(JSON.parse(decryptSecret(s.credentialsEnc)) as Record<string, string>)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k)
    : [];
  return {
    enabled: s.enabled,
    scheduleTimeUtc: s.scheduleTimeUtc,
    verifyWeekday: s.verifyWeekday,
    localRetention: s.localRetention,
    remoteRetention: s.remoteRetention,
    remotePath: s.remotePath,
    agePublicKey: s.agePublicKey,
    destination: s.destinationType ? { type: s.destinationType, config: s.destinationConfig } : null,
    // Names only — which secrets are stored, never their values.
    storedCredentials: credentialFields,
    worker: {
      lastHeartbeatAt: s.workerHeartbeatAt,
      online: Boolean(s.workerHeartbeatAt && now.getTime() - s.workerHeartbeatAt.getTime() < WORKER_OFFLINE_AFTER_MS),
    },
    nextBackupAt: s.enabled ? nextDailySlot(now, s.scheduleTimeUtc) : null,
    nextVerifyAt: s.enabled && s.verifyWeekday !== null ? nextVerifySlot(now, s.scheduleTimeUtc, s.verifyWeekday) : null,
    lastSuccessfulBackup: lastSuccess ? serializeRun(lastSuccess) : null,
  };
}

/**
 * ADMIN-only. Configuration and history for off-box backups. The backup
 * worker (packages/backup) does the work; these routes only store settings
 * and queue runs. Destination credentials are write-only: they're encrypted
 * on the way in and the API reports which ones are stored, never what they are.
 */
export async function backupRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.requireRole("ADMIN"));

  app.get("/backup/settings", async () => {
    const [settings, lastSuccess] = await Promise.all([
      getSettings(),
      prisma.backupRun.findFirst({ where: { kind: "BACKUP", status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } }),
    ]);
    return publicSettings(settings, lastSuccess);
  });

  app.put("/backup/settings", async (req, reply) => {
    const body = settingsSchema.parse(req.body);
    const existing = await getSettings();
    const storedCreds: Record<string, string | undefined> =
      existing.credentialsEnc && existing.destinationType === body.destination?.type
        ? JSON.parse(decryptSecret(existing.credentialsEnc))
        : {}; // switching destination type discards the old type's secrets

    if (body.destination) {
      const missing = missingCredentials(body.destination, storedCreds);
      if (missing) return reply.code(400).send({ error: missing });
    }
    if (body.enabled && (!body.destination || !body.agePublicKey)) {
      return reply.code(400).send({ error: "set a destination and an age public key before turning on scheduled backups" });
    }

    const mergedCreds = body.destination ? mergeCredentials(storedCreds, body.destination.credentials) : null;
    const scheduleChanged = body.enabled && (!existing.enabled || existing.scheduleTimeUtc !== body.scheduleTimeUtc);

    const data: Prisma.BackupSettingsUpdateInput = {
      enabled: body.enabled,
      scheduleTimeUtc: body.scheduleTimeUtc,
      scheduleActiveSince: body.enabled ? (scheduleChanged ? new Date() : existing.scheduleActiveSince ?? new Date()) : null,
      verifyWeekday: body.verifyWeekday,
      localRetention: body.localRetention,
      remoteRetention: body.remoteRetention,
      remotePath: body.remotePath,
      agePublicKey: body.agePublicKey,
      destinationType: body.destination?.type ?? null,
      // Prisma needs its JsonNull sentinel, not a plain null, to clear a Json column.
      destinationConfig: body.destination ? (body.destination.config as Prisma.InputJsonValue) : Prisma.JsonNull,
      credentialsEnc: mergedCreds ? encryptSecret(JSON.stringify(mergedCreds)) : null,
    };
    const updated = await prisma.backupSettings.update({ where: { id: "default" }, data });

    await recordAudit(req, "backup.settings.update", { type: "backupSettings", id: "default" }, {
      enabled: body.enabled,
      destinationType: body.destination?.type ?? null,
      scheduleTimeUtc: body.scheduleTimeUtc,
      // Which secrets were replaced, never their values.
      credentialsReplaced: Object.keys(body.destination?.credentials ?? {}).filter(
        (k) => (body.destination!.credentials as Record<string, string | undefined>)[k],
      ),
      agePublicKeyChanged: existing.agePublicKey !== body.agePublicKey,
    });
    const lastSuccess = await prisma.backupRun.findFirst({ where: { kind: "BACKUP", status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
    return publicSettings(updated, lastSuccess);
  });

  app.post("/backup/runs", async (req, reply) => {
    const { kind } = runRequestSchema.parse(req.body);
    const settings = await getSettings();
    if (kind !== "VERIFY" && !settings.destinationType) {
      return reply.code(400).send({ error: "save a destination first" });
    }
    if (kind === "BACKUP" && !settings.agePublicKey) {
      return reply.code(400).send({ error: "save an age public key first — backups are never uploaded unencrypted" });
    }
    const inFlight = await prisma.backupRun.findFirst({ where: { kind, status: { in: ["PENDING", "RUNNING"] } } });
    if (inFlight) {
      return reply.code(409).send({ error: `a ${kind.toLowerCase().replace("_", " ")} is already ${inFlight.status.toLowerCase()}` });
    }
    const run = await prisma.backupRun.create({ data: { kind, trigger: "MANUAL", requestedByEmail: req.user.email } });
    await recordAudit(req, `backup.run.${kind.toLowerCase()}`, { type: "backupRun", id: run.id });
    return reply.code(202).send(serializeRun(run));
  });

  app.get("/backup/runs", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().positive().max(200).default(30) }).parse(req.query);
    const runs = await prisma.backupRun.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    return runs.map(serializeRun);
  });
}

