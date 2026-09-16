-- CreateEnum
CREATE TYPE "FileActivityAction" AS ENUM ('CREATE', 'WRITE', 'DELETE', 'RENAME', 'READ', 'OTHER');

-- AlterTable
ALTER TABLE "FileEvent" ADD COLUMN     "actorIp" TEXT,
ADD COLUMN     "actorUser" TEXT;

-- AlterTable
ALTER TABLE "FileServer" ADD COLUMN     "activityBookmark" BIGINT,
ADD COLUMN     "activityEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "lastActivityError" TEXT,
ADD COLUMN     "winrmPasswordEnc" TEXT,
ADD COLUMN     "winrmPort" INTEGER,
ADD COLUMN     "winrmUsername" TEXT;

-- CreateTable
CREATE TABLE "FileActivity" (
    "id" TEXT NOT NULL,
    "fileServerId" TEXT NOT NULL,
    "sourceId" TEXT,
    "path" TEXT NOT NULL,
    "action" "FileActivityAction" NOT NULL,
    "userName" TEXT NOT NULL,
    "userDomain" TEXT,
    "clientIp" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileActivity_sourceId_path_occurredAt_idx" ON "FileActivity"("sourceId", "path", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileActivity_fileServerId_recordId_key" ON "FileActivity"("fileServerId", "recordId");

-- AddForeignKey
ALTER TABLE "FileActivity" ADD CONSTRAINT "FileActivity_fileServerId_fkey" FOREIGN KEY ("fileServerId") REFERENCES "FileServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileActivity" ADD CONSTRAINT "FileActivity_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
