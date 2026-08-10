-- CreateEnum
CREATE TYPE "FileEventType" AS ENUM ('CREATED', 'MODIFIED', 'DELETED', 'RENAMED', 'PERMISSION_CHANGED');

-- CreateEnum
CREATE TYPE "ClassificationJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "SensitivePatternType" AS ENUM ('SSN', 'CREDIT_CARD', 'EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('RANSOMWARE_RATE', 'SENSITIVE_DATA_EXPOSED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "watchedRoot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "eventType" "FileEventType" NOT NULL,
    "path" TEXT NOT NULL,
    "previousPath" TEXT,
    "sizeBytes" INTEGER,
    "contentSample" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageSnapshot" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "totalBytes" BIGINT NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassificationJob" (
    "id" TEXT NOT NULL,
    "fileEventId" TEXT NOT NULL,
    "status" "ClassificationJobStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ClassificationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassificationMatch" (
    "id" TEXT NOT NULL,
    "classificationJobId" TEXT NOT NULL,
    "patternType" "SensitivePatternType" NOT NULL,
    "redactedSample" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "agentId" TEXT,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_key_key" ON "Agent"("key");

-- CreateIndex
CREATE INDEX "FileEvent_agentId_occurredAt_idx" ON "FileEvent"("agentId", "occurredAt");

-- CreateIndex
CREATE INDEX "StorageSnapshot_agentId_takenAt_idx" ON "StorageSnapshot"("agentId", "takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassificationJob_fileEventId_key" ON "ClassificationJob"("fileEventId");

-- CreateIndex
CREATE INDEX "ClassificationJob_status_createdAt_idx" ON "ClassificationJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_status_createdAt_idx" ON "Alert"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "FileEvent" ADD CONSTRAINT "FileEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageSnapshot" ADD CONSTRAINT "StorageSnapshot_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationJob" ADD CONSTRAINT "ClassificationJob_fileEventId_fkey" FOREIGN KEY ("fileEventId") REFERENCES "FileEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationMatch" ADD CONSTRAINT "ClassificationMatch_classificationJobId_fkey" FOREIGN KEY ("classificationJobId") REFERENCES "ClassificationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
