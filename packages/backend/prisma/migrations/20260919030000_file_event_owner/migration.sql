-- Who owns the file, as reported by the agent. Separate from actorUser: an
-- owner is whose file it is, not an audited record of who did something.
ALTER TABLE "FileEvent" ADD COLUMN "ownerUser" TEXT;
