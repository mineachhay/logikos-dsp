CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- No password column, deliberately: see the model's comment. Credentials that
-- install an agent are administrator on the target, and are held only in the
-- backend's memory between queueing and collection.
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "hostname" TEXT,
    "username" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "requestedBy" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Deployment_agentId_status_idx" ON "Deployment"("agentId", "status");
CREATE INDEX "Deployment_createdAt_idx" ON "Deployment"("createdAt");

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
