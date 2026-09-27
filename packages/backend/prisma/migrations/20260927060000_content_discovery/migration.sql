-- Content discovery: existing files' contents classified, not only changed ones.
CREATE TABLE "ContentScan" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "mtimeMs" BIGINT NOT NULL,
    "extractor" TEXT NOT NULL,
    "contentSample" TEXT,
    "note" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentScan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContentScan_sourceId_path_key" ON "ContentScan"("sourceId", "path");
ALTER TABLE "ContentScan" ADD CONSTRAINT "ContentScan_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A job classifies a file event's sample or a content scan's.
ALTER TABLE "ClassificationJob" ALTER COLUMN "fileEventId" DROP NOT NULL;
ALTER TABLE "ClassificationJob" ADD COLUMN "contentScanId" TEXT;
CREATE UNIQUE INDEX "ClassificationJob_contentScanId_key" ON "ClassificationJob"("contentScanId");
ALTER TABLE "ClassificationJob" ADD CONSTRAINT "ClassificationJob_contentScanId_fkey" FOREIGN KEY ("contentScanId") REFERENCES "ContentScan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Matches carry their source, for grouping; existing ones get it from their event.
ALTER TABLE "ClassificationMatch" ADD COLUMN "sourceId" TEXT;
CREATE INDEX "ClassificationMatch_sourceId_idx" ON "ClassificationMatch"("sourceId");
UPDATE "ClassificationMatch" m SET "sourceId" = e."sourceId"
  FROM "ClassificationJob" j JOIN "FileEvent" e ON e."id" = j."fileEventId"
  WHERE j."id" = m."classificationJobId";

-- Discovery progress per source, as reported by the agent.
ALTER TABLE "Source" ADD COLUMN "discoveryCandidates" INTEGER;
ALTER TABLE "Source" ADD COLUMN "discoverySkippedType" INTEGER;
ALTER TABLE "Source" ADD COLUMN "discoverySkippedSize" INTEGER;
ALTER TABLE "Source" ADD COLUMN "discoveryPassStartedAt" TIMESTAMP(3);
ALTER TABLE "Source" ADD COLUMN "discoveryPassFinishedAt" TIMESTAMP(3);
