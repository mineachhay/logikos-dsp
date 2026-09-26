-- Agent, deployment and network-scan audit entries were recorded with three
-- different targetType spellings ("Agent", "Deployment", "DiscoveryScan") while
-- revoke/restore used "agent"; the Agents page lists them by one type.
UPDATE "AuditLog" SET "targetType" = 'agent' WHERE "targetType" IN ('Agent', 'Deployment', 'DiscoveryScan');
