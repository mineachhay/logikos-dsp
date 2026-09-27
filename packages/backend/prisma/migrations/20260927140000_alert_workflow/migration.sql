-- AlterTable
ALTER TABLE "Alert" ADD COLUMN "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN "acknowledgedByEmail" TEXT,
ADD COLUMN "resolvedAt" TIMESTAMP(3),
ADD COLUMN "resolvedByEmail" TEXT,
ADD COLUMN "note" TEXT;

-- CreateIndex
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt");

-- CreateIndex
CREATE INDEX "FileEvent_occurredAt_idx" ON "FileEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "FileEvent_sourceId_path_occurredAt_idx" ON "FileEvent"("sourceId", "path", "occurredAt");

-- CreateIndex
CREATE INDEX "FileActivity_occurredAt_idx" ON "FileActivity"("occurredAt");

-- CreateIndex
CREATE INDEX "FileActivity_fileServerId_occurredAt_idx" ON "FileActivity"("fileServerId", "occurredAt");
