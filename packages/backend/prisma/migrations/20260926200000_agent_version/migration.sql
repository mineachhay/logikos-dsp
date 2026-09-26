-- The build each agent runs, so the Agents page can flag outdated ones.
ALTER TABLE "Agent" ADD COLUMN "version" TEXT;
