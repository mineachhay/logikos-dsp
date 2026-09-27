-- Custom classification patterns (Settings → Classification).
ALTER TYPE "SensitivePatternType" ADD VALUE 'CUSTOM';
ALTER TABLE "ClassificationMatch" ADD COLUMN "customName" TEXT;
