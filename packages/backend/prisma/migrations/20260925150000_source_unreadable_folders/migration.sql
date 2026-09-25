-- Subfolders a share scan skipped because the account can't read them, shown on
-- the File Servers page. Replaced on every successful scan; capped list + true count.
ALTER TABLE "Source" ADD COLUMN "unreadableFolders" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL;
ALTER TABLE "Source" ADD COLUMN "unreadableFolderCount" INTEGER NOT NULL DEFAULT 0;
