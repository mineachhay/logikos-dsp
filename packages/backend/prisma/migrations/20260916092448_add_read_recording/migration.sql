-- AlterEnum
ALTER TYPE "AlertType" ADD VALUE 'BULK_FILE_READ';

-- AlterTable
ALTER TABLE "FileServer" ADD COLUMN     "recordReads" BOOLEAN NOT NULL DEFAULT false;
