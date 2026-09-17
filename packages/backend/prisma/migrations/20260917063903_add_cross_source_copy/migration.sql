-- AlterTable
ALTER TABLE "FileEvent" ADD COLUMN     "previousSourceId" TEXT;

-- AddForeignKey
ALTER TABLE "FileEvent" ADD CONSTRAINT "FileEvent_previousSourceId_fkey" FOREIGN KEY ("previousSourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
