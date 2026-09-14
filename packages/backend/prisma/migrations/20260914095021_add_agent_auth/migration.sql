-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "secretHash" TEXT;
