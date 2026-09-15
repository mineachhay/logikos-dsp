-- CreateEnum
CREATE TYPE "BackupDestinationType" AS ENUM ('S3', 'SFTP', 'GDRIVE');

-- CreateEnum
CREATE TYPE "BackupRunKind" AS ENUM ('BACKUP', 'VERIFY', 'TEST_DESTINATION');

-- CreateEnum
CREATE TYPE "BackupRunTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "BackupRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
ALTER TYPE "AlertType" ADD VALUE 'BACKUP_FAILED';

-- CreateTable
CREATE TABLE "BackupSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "scheduleTimeUtc" TEXT NOT NULL DEFAULT '03:15',
    "scheduleActiveSince" TIMESTAMP(3),
    "verifyWeekday" INTEGER DEFAULT 0,
    "localRetention" INTEGER NOT NULL DEFAULT 14,
    "remoteRetention" INTEGER NOT NULL DEFAULT 30,
    "destinationType" "BackupDestinationType",
    "destinationConfig" JSONB,
    "credentialsEnc" TEXT,
    "remotePath" TEXT NOT NULL DEFAULT 'logikos-dsp',
    "agePublicKey" TEXT,
    "workerHeartbeatAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "kind" "BackupRunKind" NOT NULL,
    "trigger" "BackupRunTrigger" NOT NULL,
    "status" "BackupRunStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByEmail" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "fileName" TEXT,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "uploaded" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupRun_status_createdAt_idx" ON "BackupRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BackupRun_createdAt_idx" ON "BackupRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackupRun_kind_scheduledFor_key" ON "BackupRun"("kind", "scheduledFor");
