CREATE TYPE "DiscoveryScanStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "DiscoveryScan" (
    "id" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "DiscoveryScanStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "DiscoveryScan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveredHost" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "hostname" TEXT,
    "openPorts" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscoveredHost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiscoveryScan_agentId_status_idx" ON "DiscoveryScan"("agentId", "status");
CREATE INDEX "DiscoveredHost_scanId_idx" ON "DiscoveredHost"("scanId");
CREATE UNIQUE INDEX "DiscoveredHost_scanId_address_key" ON "DiscoveredHost"("scanId", "address");

ALTER TABLE "DiscoveryScan" ADD CONSTRAINT "DiscoveryScan_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveredHost" ADD CONSTRAINT "DiscoveredHost_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "DiscoveryScan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
