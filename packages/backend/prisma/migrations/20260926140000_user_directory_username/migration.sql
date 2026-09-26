-- The Windows username of a directory account, so the per-account lockout finds
-- it when someone signs in as DOMAIN\name and their UPN suffix isn't the domain
-- (e.g. name@brand.example in corp.local).
ALTER TABLE "User" ADD COLUMN "directoryUsername" TEXT;
CREATE INDEX "User_directoryUsername_idx" ON "User"("directoryUsername");
-- Best guess until each person's next sign-in sets the real sAMAccountName.
UPDATE "User" SET "directoryUsername" = lower(split_part("email", '@', 1)) WHERE "source" = 'DIRECTORY';
