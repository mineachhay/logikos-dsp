-- Hand-edited: sourceId is added nullable, backfilled from one default Source
-- per existing Agent (its env-configured watchedRoot), then made NOT NULL, so
-- an install with history migrates in place.
-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('LOCAL', 'SMB', 'M365', 'GDRIVE');

-- CreateEnum
CREATE TYPE "ConnectionTestStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "sourceId" TEXT;

-- AlterTable
ALTER TABLE "FileEvent" ADD COLUMN     "sourceId" TEXT;

-- AlterTable
ALTER TABLE "StorageSnapshot" ADD COLUMN     "sourceId" TEXT;

-- CreateTable
CREATE TABLE "FileServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "domain" TEXT,
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "rootLabel" TEXT NOT NULL,
    "agentId" TEXT,
    "fileServerId" TEXT,
    "shareName" TEXT,
    "subPath" TEXT NOT NULL DEFAULT '',
    "scanIntervalSec" INTEGER NOT NULL DEFAULT 300,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" TIMESTAMP(3),
    "lastScanError" TEXT,
    "lastFileCount" INTEGER,
    "lastTotalBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- Backfill: one default Source per Agent, then point existing rows at it.
INSERT INTO "Source" ("id", "kind", "rootLabel", "agentId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       (CASE
          WHEN "watchedRoot" LIKE 'smb://%'    THEN 'SMB'
          WHEN "watchedRoot" LIKE 'm365://%'   THEN 'M365'
          WHEN "watchedRoot" LIKE 'gdrive://%' THEN 'GDRIVE'
          ELSE 'LOCAL'
        END)::"SourceKind",
       "watchedRoot", "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Agent";

UPDATE "FileEvent" f SET "sourceId" = s."id" FROM "Source" s WHERE s."agentId" = f."agentId";
UPDATE "StorageSnapshot" t SET "sourceId" = s."id" FROM "Source" s WHERE s."agentId" = t."agentId";
UPDATE "Alert" a SET "sourceId" = s."id" FROM "Source" s WHERE s."agentId" = a."agentId";

ALTER TABLE "FileEvent" ALTER COLUMN "sourceId" SET NOT NULL;
ALTER TABLE "StorageSnapshot" ALTER COLUMN "sourceId" SET NOT NULL;

-- CreateTable
CREATE TABLE "ConnectionTest" (
    "id" TEXT NOT NULL,
    "fileServerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "shareName" TEXT NOT NULL,
    "subPath" TEXT NOT NULL DEFAULT '',
    "status" "ConnectionTestStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ConnectionTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FileServer_name_key" ON "FileServer"("name");

-- CreateIndex
CREATE INDEX "Source_agentId_idx" ON "Source"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "Source_fileServerId_shareName_subPath_key" ON "Source"("fileServerId", "shareName", "subPath");

-- CreateIndex
CREATE INDEX "ConnectionTest_agentId_status_idx" ON "ConnectionTest"("agentId", "status");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "FileEvent_sourceId_occurredAt_idx" ON "FileEvent"("sourceId", "occurredAt");

-- CreateIndex
CREATE INDEX "StorageSnapshot_sourceId_takenAt_idx" ON "StorageSnapshot"("sourceId", "takenAt");

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_fileServerId_fkey" FOREIGN KEY ("fileServerId") REFERENCES "FileServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionTest" ADD CONSTRAINT "ConnectionTest_fileServerId_fkey" FOREIGN KEY ("fileServerId") REFERENCES "FileServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionTest" ADD CONSTRAINT "ConnectionTest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileEvent" ADD CONSTRAINT "FileEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageSnapshot" ADD CONSTRAINT "StorageSnapshot_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
