import { beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "ResponseAction","Alert","ClassificationMatch","ClassificationJob","FileEvent","StorageSnapshot","Agent","User" RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
