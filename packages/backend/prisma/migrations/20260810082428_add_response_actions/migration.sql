-- CreateEnum
CREATE TYPE "ResponseActionType" AS ENUM ('WEBHOOK_NOTIFICATION');

-- CreateEnum
CREATE TYPE "ResponseActionStatus" AS ENUM ('PENDING', 'REJECTED', 'EXECUTED', 'FAILED');

-- CreateTable
CREATE TABLE "ResponseAction" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "type" "ResponseActionType" NOT NULL,
    "status" "ResponseActionStatus" NOT NULL DEFAULT 'PENDING',
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "resultMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResponseAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResponseAction_status_createdAt_idx" ON "ResponseAction"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ResponseAction" ADD CONSTRAINT "ResponseAction_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResponseAction" ADD CONSTRAINT "ResponseAction_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
