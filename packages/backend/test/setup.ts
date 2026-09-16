import { beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { assertTestDatabase } from "./assertTestDatabase.js";

// Checked again here, not just in globalSetup: this is the file that truncates.
assertTestDatabase();

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "LoginAttempt","FileActivity","BackupRun","BackupSettings","AuditLog","ConnectionTest","ResponseAction","Alert","ClassificationMatch","ClassificationJob","FileEvent","StorageSnapshot","Source","FileServer","Agent","User" RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
