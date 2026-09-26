-- Sign-in with Active Directory accounts (auth/directory.ts).
CREATE TYPE "UserSource" AS ENUM ('LOCAL', 'DIRECTORY');
ALTER TABLE "User" ADD COLUMN "source" "UserSource" NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "User" ADD COLUMN "directoryGuid" TEXT;
ALTER TABLE "User" ADD COLUMN "directoryDn" TEXT;
ALTER TABLE "User" ADD COLUMN "directoryCheckedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_directoryGuid_key" ON "User"("directoryGuid");

CREATE TABLE "DirectorySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "domain" TEXT NOT NULL DEFAULT '',
    "servers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "port" INTEGER NOT NULL DEFAULT 636,
    "baseDn" TEXT NOT NULL DEFAULT '',
    "bindUsername" TEXT NOT NULL DEFAULT '',
    "bindPasswordEnc" TEXT,
    "caCertPem" TEXT NOT NULL DEFAULT '',
    "adminGroup" TEXT NOT NULL DEFAULT '',
    "viewerGroup" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DirectorySettings_pkey" PRIMARY KEY ("id")
);
