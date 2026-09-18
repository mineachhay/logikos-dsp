-- The address an agent last called in from. Coverage needs it because a
-- network scan often can't name a machine: a workgroup has no DNS records to
-- reverse, so hostname matching has nothing to match on.
ALTER TABLE "Agent" ADD COLUMN "lastIp" TEXT;
