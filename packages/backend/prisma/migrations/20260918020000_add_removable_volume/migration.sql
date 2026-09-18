-- Where a file landed. Existing rows are all fixed storage, which is what the
-- default records; no backfill is needed or possible for them.
ALTER TABLE "FileEvent" ADD COLUMN "removable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FileEvent" ADD COLUMN "volumeLabel" TEXT;
ALTER TABLE "FileEvent" ADD COLUMN "volumeSerial" TEXT;

ALTER TYPE "AlertType" ADD VALUE 'COPY_TO_REMOVABLE';

-- Copies onto removable media are looked up by volume when investigating
-- "what went onto that stick", which is a different question from the
-- path/time lookups every other index here serves.
CREATE INDEX "FileEvent_removable_occurredAt_idx" ON "FileEvent" ("removable", "occurredAt") WHERE "removable";
