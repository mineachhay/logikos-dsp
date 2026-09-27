-- Disk space where local backups are kept, reported with the worker heartbeat.
ALTER TABLE "BackupSettings" ADD COLUMN "workerDiskFreeBytes" BIGINT;
ALTER TABLE "BackupSettings" ADD COLUMN "workerDiskTotalBytes" BIGINT;
