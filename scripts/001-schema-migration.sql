-- ============================================================================
-- Phase 1: Schema Migration - Add installation tracker tables to autstand DB
-- ============================================================================
-- Run against: autstand database on autstandpostgresql.postgres.database.azure.com
-- IMPORTANT: Back up autstand before running!
--   pg_dump -h autstandpostgresql.postgres.database.azure.com -U Sharpness6069 -d autstand -F c -f autstand_backup.dump
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1A. Enrich existing projects table
-- ============================================================================

ALTER TABLE projects ADD COLUMN IF NOT EXISTS slug             VARCHAR(100) UNIQUE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS location         TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_user         TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date       TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date         TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS manifest_version TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created          TIMESTAMPTZ DEFAULT NOW();

-- ============================================================================
-- 1B. Create Devices table (single-table inheritance)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "Devices" (
  "Id"                        SERIAL PRIMARY KEY,
  "Name"                      TEXT NOT NULL,
  "ProjectId"                 INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "NewOrExisting"             INTEGER NOT NULL DEFAULT 0,
  "WorkType"                  INTEGER,
  "Description"               TEXT,
  "Subsystem"                 TEXT,
  "DeviceType"                VARCHAR(34) NOT NULL,
  "EthernetFromId"            INTEGER,
  "ControlledFromId"          INTEGER,
  "EnclosureType"             INTEGER,
  "ConveyorType"              INTEGER,
  "ControlledById"            INTEGER,
  "BedLengthFt"               REAL,
  "MiscItemDashboardCategory" TEXT,
  "BreakerLoad"               REAL,
  "BreakerNumber"             INTEGER,
  "BreakerSize"               INTEGER,
  "CircuitId"                 INTEGER,
  "IsFeeder"                  BOOLEAN,
  "SourceId"                  INTEGER,
  "Voltage"                   REAL
);

CREATE INDEX IF NOT EXISTS "IX_Device_Project_Type"          ON "Devices" ("ProjectId", "DeviceType");
CREATE INDEX IF NOT EXISTS "IX_Device_Project_Type_WorkType" ON "Devices" ("ProjectId", "DeviceType", "WorkType");
CREATE INDEX IF NOT EXISTS "IX_Devices_ProjectId"            ON "Devices" ("ProjectId");
CREATE INDEX IF NOT EXISTS "IX_Devices_Name_Project"         ON "Devices" ("Name", "ProjectId");

-- ============================================================================
-- 1C. Create all 13 install progress tables
-- ============================================================================

-- VFD Installs
CREATE TABLE IF NOT EXISTS "VFDInstalls" (
  "VFDId"             INTEGER PRIMARY KEY,
  "SupportsInstalled" REAL NOT NULL DEFAULT 0,
  "VFDInstalled"      REAL NOT NULL DEFAULT 0,
  "ConduitInstalled"  REAL NOT NULL DEFAULT 0,
  "WireOrCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"      REAL NOT NULL DEFAULT 0,
  "PoweredUp"         REAL NOT NULL DEFAULT 0,
  "PercentComplete"   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "IX_VFDInstall_VFDId" ON "VFDInstalls" ("VFDId");

-- Enclosure Installs
CREATE TABLE IF NOT EXISTS "EnclosureInstalls" (
  "EnclosureId"        INTEGER PRIMARY KEY,
  "SupportsInstalled"  REAL NOT NULL DEFAULT 0,
  "ConduitInstalled"   REAL NOT NULL DEFAULT 0,
  "ControlCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"       REAL NOT NULL DEFAULT 0,
  "PoweredUp"          REAL NOT NULL DEFAULT 0,
  "VoltageReadings"    REAL NOT NULL DEFAULT 0,
  "PercentComplete"    REAL NOT NULL DEFAULT 0
);

-- Enclosure Demos
CREATE TABLE IF NOT EXISTS "EnclosureDemos" (
  "EnclosureId"      INTEGER PRIMARY KEY,
  "WireRemoved"      REAL NOT NULL DEFAULT 0,
  "ConduitRemoved"   REAL NOT NULL DEFAULT 0,
  "SupportsRemoved"  REAL NOT NULL DEFAULT 0,
  "EnclosureRemoved" REAL NOT NULL DEFAULT 0,
  "PercentComplete"  REAL NOT NULL DEFAULT 0
);

-- Enclosure Reworks
CREATE TABLE IF NOT EXISTS "EnclosureReworks" (
  "EnclosureId"        INTEGER PRIMARY KEY,
  "SupportsInstalled"  REAL NOT NULL DEFAULT 0,
  "ConduitInstalled"   REAL NOT NULL DEFAULT 0,
  "ControlCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"       REAL NOT NULL DEFAULT 0,
  "PoweredUp"          REAL NOT NULL DEFAULT 0,
  "VoltageReadings"    REAL NOT NULL DEFAULT 0,
  "PercentComplete"    REAL NOT NULL DEFAULT 0
);

-- Control Device Installs
CREATE TABLE IF NOT EXISTS "ControlDeviceInstalls" (
  "DeviceId"          INTEGER PRIMARY KEY,
  "DeviceInstalled"   REAL NOT NULL DEFAULT 0,
  "ConduitInstalled"  REAL NOT NULL DEFAULT 0,
  "WireOrCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"      REAL NOT NULL DEFAULT 0,
  "PoweredUp"         REAL NOT NULL DEFAULT 0,
  "PercentComplete"   REAL NOT NULL DEFAULT 0
);

-- Feeder Installs
CREATE TABLE IF NOT EXISTS "FeederInstalls" (
  "CircuitId"         INTEGER PRIMARY KEY,
  "SupportsInstalled" REAL NOT NULL DEFAULT 0,
  "ConduitInstalled"  REAL NOT NULL DEFAULT 0,
  "WireOrCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"      REAL NOT NULL DEFAULT 0,
  "MeggerTest"        REAL NOT NULL DEFAULT 0,
  "VoltageReadings"   REAL NOT NULL DEFAULT 0,
  "PercentComplete"   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "IX_FeederInstall_CircuitId" ON "FeederInstalls" ("CircuitId");

-- 480V Circuit Installs
CREATE TABLE IF NOT EXISTS "Circuit480VInstalls" (
  "CircuitId"         INTEGER PRIMARY KEY,
  "SupportsInstalled" REAL NOT NULL DEFAULT 0,
  "ConduitInstalled"  REAL NOT NULL DEFAULT 0,
  "WireOrCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"      REAL NOT NULL DEFAULT 0,
  "MeggerTest"        REAL NOT NULL DEFAULT 0,
  "VoltageReadings"   REAL NOT NULL DEFAULT 0,
  "PercentComplete"   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "IX_Circuit480VInstall_CircuitId" ON "Circuit480VInstalls" ("CircuitId");

-- 120V Circuit Installs
CREATE TABLE IF NOT EXISTS "Circuit120VInstalls" (
  "CircuitId"         INTEGER PRIMARY KEY,
  "SupportsInstalled" REAL NOT NULL DEFAULT 0,
  "ConduitInstalled"  REAL NOT NULL DEFAULT 0,
  "WireOrCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"      REAL NOT NULL DEFAULT 0,
  "MeggerTest"        REAL NOT NULL DEFAULT 0,
  "VoltageReadings"   REAL NOT NULL DEFAULT 0,
  "PercentComplete"   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "IX_Circuit120VInstall_CircuitId" ON "Circuit120VInstalls" ("CircuitId");

-- Conveyor Demos
CREATE TABLE IF NOT EXISTS "ConveyorDemos" (
  "ConveyorId"         INTEGER PRIMARY KEY,
  "CircuitDeenergized" REAL NOT NULL DEFAULT 0,
  "WireRemoved"        REAL NOT NULL DEFAULT 0,
  "ConduitRemoved"     REAL NOT NULL DEFAULT 0,
  "DevicesRemoved"     REAL NOT NULL DEFAULT 0,
  "PercentComplete"    REAL NOT NULL DEFAULT 0
);

-- Conveyor Reworks
CREATE TABLE IF NOT EXISTS "ConveyorReworks" (
  "ConveyorId"          INTEGER PRIMARY KEY,
  "CircuitDeenergized"  REAL NOT NULL DEFAULT 0,
  "PicturesTaken"       REAL NOT NULL DEFAULT 0,
  "WireRemoved"         REAL NOT NULL DEFAULT 0,
  "ConduitRemoved"      REAL NOT NULL DEFAULT 0,
  "DevicesRemoved"      REAL NOT NULL DEFAULT 0,
  "NewDevicesInstalled" REAL NOT NULL DEFAULT 0,
  "NewConduitInstalled" REAL NOT NULL DEFAULT 0,
  "NewWirePulled"       REAL NOT NULL DEFAULT 0,
  "NewWireTerminated"   REAL NOT NULL DEFAULT 0,
  "PercentComplete"     REAL NOT NULL DEFAULT 0
);

-- Sorter Chute Installs
CREATE TABLE IF NOT EXISTS "SorterChuteInstalls" (
  "ChuteId"           INTEGER PRIMARY KEY,
  "DevicesInstalled"  REAL NOT NULL DEFAULT 0,
  "ConduitInstalled"  REAL NOT NULL DEFAULT 0,
  "WireOrCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"      REAL NOT NULL DEFAULT 0,
  "PoweredUp"         REAL NOT NULL DEFAULT 0,
  "PercentComplete"   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "IX_SorterChuteInstall_ChuteId" ON "SorterChuteInstalls" ("ChuteId");

-- Ethernet Installs
CREATE TABLE IF NOT EXISTS "EthernetInstalls" (
  "ToId"              INTEGER PRIMARY KEY,
  "FromId"            INTEGER,
  "ConduitInstalled"  REAL NOT NULL DEFAULT 0,
  "WireOrCablePulled" REAL NOT NULL DEFAULT 0,
  "Terminations"      REAL NOT NULL DEFAULT 0,
  "PercentComplete"   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "IX_EthernetInstall_FromId"  ON "EthernetInstalls" ("FromId");
CREATE INDEX IF NOT EXISTS "IX_EthernetInstall_ToId"    ON "EthernetInstalls" ("ToId");
CREATE INDEX IF NOT EXISTS "IX_EthernetInstalls_FromId" ON "EthernetInstalls" ("FromId");

-- Misc Item Installs
CREATE TABLE IF NOT EXISTS "MiscItemInstalls" (
  "ItemId"          INTEGER PRIMARY KEY,
  "Installed"       REAL NOT NULL DEFAULT 0,
  "PercentComplete" REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "IX_MiscItemInstall_ItemId" ON "MiscItemInstalls" ("ItemId");

-- ============================================================================
-- 1D. Create Daily Reports + Work Items
-- ============================================================================

CREATE TABLE IF NOT EXISTS "DailyReports" (
  "Id"                        SERIAL PRIMARY KEY,
  "CreatedAt"                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ProjectId"                 INTEGER NOT NULL,
  "Company"                   TEXT,
  "Name"                      TEXT,
  "Contact"                   TEXT,
  "Date"                      DATE NOT NULL,
  "ToolboxTalkAttendance"     TEXT[] DEFAULT '{}',
  "ToolboxTalkTopics"         TEXT,
  "SafetyIncidents"           TEXT,
  "Manpower"                  INTEGER NOT NULL DEFAULT 0,
  "HoursWorked"               REAL NOT NULL DEFAULT 0,
  "OtherWorkAccomplished"     TEXT,
  "PlannedWorkTasks"          TEXT,
  "JhaComplianceCheckbox"     BOOLEAN DEFAULT FALSE,
  "JhaComplianceVerifierName" TEXT,
  "RisksAndIssues"            TEXT
);
CREATE INDEX IF NOT EXISTS "IX_DailyReport_Project_Date" ON "DailyReports" ("ProjectId", "Date");
CREATE INDEX IF NOT EXISTS "IX_DailyReports_ProjectId"   ON "DailyReports" ("ProjectId");

CREATE TABLE IF NOT EXISTS "ReportWorkItems" (
  "Id"                 SERIAL PRIMARY KEY,
  "DailyReportId"      INTEGER NOT NULL,
  "DeviceId"           INTEGER NOT NULL,
  "Activity"           TEXT DEFAULT '',
  "PercentageDelta"    INTEGER NOT NULL DEFAULT 0,
  "Notes"              TEXT,
  "DashboardTableName" TEXT DEFAULT '',
  "PercentageAfter"    INTEGER,
  "PercentageBefore"   INTEGER
);
CREATE INDEX IF NOT EXISTS "IX_ReportWorkItems_DailyReportId"              ON "ReportWorkItems" ("DailyReportId");
CREATE INDEX IF NOT EXISTS "IX_ReportWorkItems_DeviceId"                   ON "ReportWorkItems" ("DeviceId");
CREATE INDEX IF NOT EXISTS "IX_WorkItem_DailyReport_Device_TableName"      ON "ReportWorkItems" ("DailyReportId", "DeviceId", "DashboardTableName", "Activity", "PercentageDelta");
CREATE INDEX IF NOT EXISTS "IX_WorkItem_Device_Activity"                   ON "ReportWorkItems" ("DeviceId", "Activity", "PercentageDelta");

-- ============================================================================
-- 1E. Create Application Users + Project Roles
-- ============================================================================

CREATE TABLE IF NOT EXISTS "ApplicationUsers" (
  "Id"              SERIAL PRIMARY KEY,
  "AzureAdObjectId" VARCHAR(256) UNIQUE NOT NULL,
  "Email"           VARCHAR(256) NOT NULL,
  "Name"            VARCHAR(256) NOT NULL,
  "FirstLoginAt"    TIMESTAMPTZ DEFAULT NOW(),
  "LastLoginAt"     TIMESTAMPTZ DEFAULT NOW(),
  "IsAzureAdAdmin"  BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS "UserProjectRoles" (
  "Id"        SERIAL PRIMARY KEY,
  "UserId"    INTEGER NOT NULL REFERENCES "ApplicationUsers"("Id") ON DELETE CASCADE,
  "ProjectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "Role"      TEXT DEFAULT 'Viewer'
);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_UserProjectRole"          ON "UserProjectRoles" ("UserId", "ProjectId");
CREATE INDEX IF NOT EXISTS "IX_UserProjectRole_UserId"          ON "UserProjectRoles" ("UserId");
CREATE INDEX IF NOT EXISTS "IX_UserProjectRole_ProjectId"       ON "UserProjectRoles" ("ProjectId");

-- ============================================================================
-- 1F. Create Tracker Audit Logs (separate from cloud's audit_logs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "TrackerAuditLogs" (
  "Id"                 SERIAL PRIMARY KEY,
  "Timestamp"          TIMESTAMPTZ DEFAULT NOW(),
  "UserId"             VARCHAR(256) NOT NULL,
  "UserName"           VARCHAR(256) NOT NULL,
  "UserEmail"          VARCHAR(256),
  "Action"             VARCHAR(50) NOT NULL,
  "DeviceId"           INTEGER,
  "ProjectId"          INTEGER,
  "DashboardTableName" VARCHAR(100),
  "FieldName"          VARCHAR(100),
  "ValueBefore"        REAL,
  "ValueAfter"         REAL,
  "ReportId"           INTEGER,
  "Details"            TEXT
);
CREATE INDEX IF NOT EXISTS "IX_TrackerAuditLog_Project_Timestamp" ON "TrackerAuditLogs" ("ProjectId", "Timestamp");
CREATE INDEX IF NOT EXISTS "IX_TrackerAuditLog_UserId"            ON "TrackerAuditLogs" ("UserId");
CREATE INDEX IF NOT EXISTS "IX_TrackerAuditLog_Timestamp"         ON "TrackerAuditLogs" ("Timestamp");

-- ============================================================================
-- 1G. EF Migrations History (legacy from .NET backend)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory" (
  "MigrationId"    VARCHAR(150) PRIMARY KEY,
  "ProductVersion" VARCHAR(32) NOT NULL
);

-- ============================================================================
-- 1H. Add device_id to ios table (cross-link to Devices)
-- ============================================================================

ALTER TABLE ios ADD COLUMN IF NOT EXISTS device_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_ios_device_id ON ios (device_id);

-- ============================================================================
-- 1I. Create UserRole enum type if needed (for Prisma compatibility)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserRole') THEN
    CREATE TYPE "UserRole" AS ENUM ('Viewer', 'Coordinator', 'Admin');
  END IF;
END$$;

COMMIT;

-- ============================================================================
-- Verification queries (run after migration)
-- ============================================================================
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
-- SELECT column_name FROM information_schema.columns WHERE table_name='projects' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name='ios' AND column_name='device_id';
