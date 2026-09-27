-- Settings changed on the Settings page; defaults live in code (packages/shared/src/settings.ts).
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByEmail" TEXT,
    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);
