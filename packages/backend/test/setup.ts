import { beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { invalidateSettings } from "../src/settings.js";
import { assertTestDatabase } from "./assertTestDatabase.js";

// Checked again here, not just in globalSetup: this is the file that truncates.
assertTestDatabase();

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Setting","DirectorySettings","ContentScan","RetentionSettings","LoginAttempt","FileActivity","BackupRun","BackupSettings","AuditLog","ConnectionTest","ResponseAction","Alert","ClassificationMatch","ClassificationJob","FileEvent","StorageSnapshot","Source","FileServer","Agent","User" RESTART IDENTITY CASCADE`,
  );
  // Settings are cached for a few seconds; a test must not see the last one's.
  invalidateSettings();
});

afterAll(async () => {
  await prisma.$disconnect();
});
