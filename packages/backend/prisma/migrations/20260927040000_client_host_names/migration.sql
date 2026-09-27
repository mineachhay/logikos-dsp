-- The machine a change came from, by name, resolved when it was recorded (reverseDns.ts).
ALTER TABLE "FileActivity" ADD COLUMN "clientHost" TEXT;
ALTER TABLE "FileEvent" ADD COLUMN "actorHost" TEXT;
