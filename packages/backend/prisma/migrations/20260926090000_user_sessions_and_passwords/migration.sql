-- Revocable sessions and admin password resets (see auth/plugin.ts, routes/users.ts).
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

-- Emails are compared lowercase from now on (auth/passwordPolicy.ts normalizeEmail).
-- If two accounts differ only by case this fails on the unique index instead of
-- silently merging them; resolve that by hand and re-run.
UPDATE "User" SET "email" = lower(trim("email")) WHERE "email" <> lower(trim("email"));
