-- CreateTable
CREATE TABLE "RetentionSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "fileEventDays" INTEGER NOT NULL DEFAULT 180,
    "fileActivityDays" INTEGER NOT NULL DEFAULT 90,
    "storageSnapshotDays" INTEGER NOT NULL DEFAULT 365,
    "resolvedAlertDays" INTEGER NOT NULL DEFAULT 365,
    "loginAttemptDays" INTEGER NOT NULL DEFAULT 30,
    "lastRunAt" TIMESTAMP(3),
    "lastRunSummary" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionSettings_pkey" PRIMARY KEY ("id")
);
