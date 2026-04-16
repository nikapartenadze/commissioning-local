import Database from 'better-sqlite3'
import { resolveDatabasePath } from '@/lib/storage-paths'

// ── Singleton database instance ──────────────────────────────────

const globalForDb = globalThis as unknown as { db: Database.Database | undefined }

function createDb(): Database.Database {
  const fullPath = resolveDatabasePath()

  console.log(`[DB] Opening database at: ${fullPath}`)
  const db = new Database(fullPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = FULL')      // Prefer durability over write throughput for commissioning data
  db.pragma('cache_size = -8000')      // 8MB page cache (default was 2MB)
  db.pragma('temp_store = MEMORY')     // Temp tables in RAM, not disk
  db.pragma('mmap_size = 30000000')    // 30MB memory-mapped I/O for faster reads

  return db
}

export const db = globalForDb.db ?? createDb()
if (process.env.NODE_ENV !== 'production') globalForDb.db = db

// ── Schema initialization (runs on every startup) ────────────────

// Auto-run on import — ensures tables exist even on old Prisma databases
try {
  initializeSchema()
  // Add new columns for existing databases (safe: SQLite ignores if column already exists)
  const migrations = [
    'ALTER TABLE Ios ADD COLUMN InstallationStatus TEXT',
    'ALTER TABLE Ios ADD COLUMN InstallationPercent REAL',
    'ALTER TABLE Ios ADD COLUMN PoweredUp INTEGER',
    'ALTER TABLE Ios ADD COLUMN TestedBy TEXT',
    'ALTER TABLE Ios ADD COLUMN IoNumber TEXT',
    'ALTER TABLE L2Columns ADD COLUMN Description TEXT',
    'ALTER TABLE L2Columns ADD COLUMN InputType TEXT',
    'ALTER TABLE L2Columns ADD COLUMN IsSystem INTEGER DEFAULT 0',
    'ALTER TABLE L2Columns ADD COLUMN IsEditable INTEGER DEFAULT 1',
    'ALTER TABLE L2Columns ADD COLUMN IncludeInProgress INTEGER DEFAULT 0',
    'ALTER TABLE TestHistories ADD COLUMN Source TEXT',
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }
  try {
    db.exec(`
      UPDATE L2Columns
      SET InputType = CASE
        WHEN COALESCE(NULLIF(InputType, ''), '') <> '' THEN InputType
        WHEN ColumnType = 'check' THEN 'pass_fail'
        WHEN ColumnType = 'number' THEN 'number'
        WHEN ColumnType = 'readonly' THEN 'readonly'
        ELSE 'text'
      END
    `)
    db.exec(`UPDATE L2Columns SET IsSystem = CASE WHEN ColumnType = 'readonly' THEN 1 ELSE COALESCE(IsSystem, 0) END`)
    db.exec(`UPDATE L2Columns SET IsEditable = CASE WHEN COALESCE(InputType, ColumnType) = 'readonly' THEN 0 ELSE 1 END`)
    db.exec(`UPDATE L2Columns SET IncludeInProgress = CASE WHEN ColumnType = 'check' THEN 1 ELSE COALESCE(IncludeInProgress, 0) END`)
  } catch { /* non-critical */ }
  // Indexes for L2 query performance
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_l2cells_device_column ON L2CellValues(DeviceId, ColumnId)') } catch { /* already exists */ }
  // Update query planner statistics (deferred to avoid blocking startup)
  setTimeout(() => {
    try { db.pragma('analysis_limit = 400'); db.exec('ANALYZE') } catch { /* non-critical */ }
  }, 10_000)
} catch (e) {
  console.warn('[DB] Schema init warning:', (e as Error).message)
}

export function initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      Name TEXT NOT NULL,
      Description TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')),
      UpdatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS Subsystems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ProjectId INTEGER NOT NULL REFERENCES Projects(id) ON DELETE CASCADE,
      Name TEXT,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_subsystems_projectid ON Subsystems(ProjectId);

    CREATE TABLE IF NOT EXISTS Ios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL REFERENCES Subsystems(id) ON DELETE CASCADE,
      Name TEXT,
      Description TEXT,
      Result TEXT,
      Timestamp TEXT,
      Comments TEXT,
      "Order" INTEGER,
      Version INTEGER DEFAULT 0,
      TagType TEXT,
      CloudSyncedAt TEXT,
      NetworkDeviceName TEXT,
      AssignedTo TEXT,
      PunchlistStatus TEXT,
      Trade TEXT,
      ClarificationNote TEXT,
      InstallationStatus TEXT,
      InstallationPercent REAL,
      PoweredUp INTEGER,
      TestedBy TEXT,
      IoNumber TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ios_subsystemid ON Ios(SubsystemId);
    CREATE INDEX IF NOT EXISTS idx_ios_result ON Ios(Result);

    CREATE TABLE IF NOT EXISTS TestHistories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      IoId INTEGER NOT NULL REFERENCES Ios(id) ON DELETE CASCADE,
      Result TEXT,
      Timestamp TEXT NOT NULL,
      Comments TEXT,
      TestedBy TEXT,
      State TEXT,
      FailureMode TEXT,
      Source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_testhistories_ioid ON TestHistories(IoId);
    CREATE INDEX IF NOT EXISTS idx_testhistories_timestamp ON TestHistories(Timestamp);

    CREATE TABLE IF NOT EXISTS Users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      FullName TEXT UNIQUE NOT NULL,
      Pin TEXT NOT NULL,
      IsAdmin INTEGER DEFAULT 0,
      IsActive INTEGER DEFAULT 1,
      CreatedAt TEXT NOT NULL,
      LastUsedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS PendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      IoId INTEGER NOT NULL,
      InspectorName TEXT,
      TestResult TEXT,
      Comments TEXT,
      State TEXT,
      Timestamp TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0,
      LastError TEXT,
      Version INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pendingsyncs_ioid ON PendingSyncs(IoId);
    CREATE INDEX IF NOT EXISTS idx_pendingsyncs_createdat ON PendingSyncs(CreatedAt);

    CREATE TABLE IF NOT EXISTS TagTypeDiagnostics (
      TagType TEXT NOT NULL,
      FailureMode TEXT NOT NULL,
      DiagnosticSteps TEXT NOT NULL,
      CreatedAt TEXT DEFAULT (datetime('now')),
      UpdatedAt TEXT,
      PRIMARY KEY (TagType, FailureMode)
    );

    CREATE TABLE IF NOT EXISTS ChangeRequests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      IoId INTEGER,
      RequestType TEXT NOT NULL,
      CurrentValue TEXT,
      RequestedValue TEXT,
      StructuredChanges TEXT,
      Reason TEXT NOT NULL,
      RequestedBy TEXT NOT NULL,
      Status TEXT DEFAULT 'pending',
      CreatedAt TEXT DEFAULT (datetime('now')),
      UpdatedAt TEXT,
      ReviewedBy TEXT,
      ReviewNote TEXT,
      CloudId INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_changerequests_ioid ON ChangeRequests(IoId);
    CREATE INDEX IF NOT EXISTS idx_changerequests_status ON ChangeRequests(Status);

    CREATE TABLE IF NOT EXISTS NetworkRings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      Name TEXT NOT NULL,
      McmName TEXT NOT NULL,
      McmIp TEXT,
      McmTag TEXT,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_networkrings_subsystemid ON NetworkRings(SubsystemId);

    CREATE TABLE IF NOT EXISTS NetworkNodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      RingId INTEGER NOT NULL REFERENCES NetworkRings(id) ON DELETE CASCADE,
      Name TEXT NOT NULL,
      Position INTEGER NOT NULL,
      IpAddress TEXT,
      CableIn TEXT,
      CableOut TEXT,
      StatusTag TEXT,
      TotalPorts INTEGER DEFAULT 28,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_networknodes_ringid ON NetworkNodes(RingId);

    CREATE TABLE IF NOT EXISTS NetworkPorts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      NodeId INTEGER NOT NULL REFERENCES NetworkNodes(id) ON DELETE CASCADE,
      PortNumber TEXT NOT NULL,
      CableLabel TEXT,
      DeviceName TEXT,
      DeviceType TEXT,
      DeviceIp TEXT,
      StatusTag TEXT,
      ParentPortId INTEGER REFERENCES NetworkPorts(id) ON DELETE CASCADE,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_networkports_nodeid ON NetworkPorts(NodeId);
    CREATE INDEX IF NOT EXISTS idx_networkports_parentportid ON NetworkPorts(ParentPortId);

    CREATE TABLE IF NOT EXISTS EStopZones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER,
      Name TEXT NOT NULL,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS EStopEpcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ZoneId INTEGER NOT NULL REFERENCES EStopZones(id) ON DELETE CASCADE,
      Name TEXT NOT NULL,
      CheckTag TEXT NOT NULL,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_estopepcs_zoneid ON EStopEpcs(ZoneId);

    CREATE TABLE IF NOT EXISTS EStopIoPoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      EpcId INTEGER NOT NULL REFERENCES EStopEpcs(id) ON DELETE CASCADE,
      Tag TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_estopiopoints_epcid ON EStopIoPoints(EpcId);

    CREATE TABLE IF NOT EXISTS EStopVfds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      EpcId INTEGER NOT NULL REFERENCES EStopEpcs(id) ON DELETE CASCADE,
      Tag TEXT NOT NULL,
      StoTag TEXT NOT NULL,
      MustStop INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_estopvfds_epcid ON EStopVfds(EpcId);

    CREATE TABLE IF NOT EXISTS SafetyZones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL REFERENCES Subsystems(id) ON DELETE CASCADE,
      Name TEXT NOT NULL,
      StoSignal TEXT NOT NULL,
      BssTag TEXT NOT NULL,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_safetyzones_subsystemid ON SafetyZones(SubsystemId);

    CREATE TABLE IF NOT EXISTS SafetyZoneDrives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ZoneId INTEGER NOT NULL REFERENCES SafetyZones(id) ON DELETE CASCADE,
      Name TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_safetyzonedrives_zoneid ON SafetyZoneDrives(ZoneId);

    CREATE TABLE IF NOT EXISTS SafetyOutputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL REFERENCES Subsystems(id) ON DELETE CASCADE,
      Tag TEXT NOT NULL,
      Description TEXT NOT NULL,
      OutputType TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_safetyoutputs_subsystemid ON SafetyOutputs(SubsystemId);

    CREATE TABLE IF NOT EXISTS Punchlists (
      id INTEGER PRIMARY KEY,
      Name TEXT NOT NULL,
      SubsystemId INTEGER
    );

    CREATE TABLE IF NOT EXISTS PunchlistItems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      PunchlistId INTEGER NOT NULL REFERENCES Punchlists(id) ON DELETE CASCADE,
      IoId INTEGER NOT NULL,
      UNIQUE(PunchlistId, IoId)
    );
    CREATE INDEX IF NOT EXISTS idx_punchlistitems_punchlistid ON PunchlistItems(PunchlistId);

    CREATE TABLE IF NOT EXISTS L2Sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudId INTEGER,
      Name TEXT NOT NULL,
      DisplayName TEXT,
      DisplayOrder INTEGER NOT NULL,
      Discipline TEXT,
      DeviceCount INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS L2Columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudId INTEGER,
      SheetId INTEGER NOT NULL REFERENCES L2Sheets(id) ON DELETE CASCADE,
      Name TEXT NOT NULL,
      ColumnType TEXT NOT NULL,
      InputType TEXT,
      DisplayOrder INTEGER NOT NULL,
      IsSystem INTEGER DEFAULT 0,
      IsEditable INTEGER DEFAULT 1,
      IncludeInProgress INTEGER DEFAULT 0,
      IsRequired INTEGER DEFAULT 0,
      Description TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_l2columns_sheetid ON L2Columns(SheetId);

    CREATE TABLE IF NOT EXISTS L2Devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudId INTEGER,
      SheetId INTEGER NOT NULL REFERENCES L2Sheets(id) ON DELETE CASCADE,
      DeviceName TEXT NOT NULL,
      Mcm TEXT,
      Subsystem TEXT,
      DisplayOrder INTEGER NOT NULL,
      CompletedChecks INTEGER DEFAULT 0,
      TotalChecks INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_l2devices_sheetid ON L2Devices(SheetId);

    CREATE TABLE IF NOT EXISTS L2CellValues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudCellId INTEGER,
      DeviceId INTEGER NOT NULL REFERENCES L2Devices(id) ON DELETE CASCADE,
      ColumnId INTEGER NOT NULL REFERENCES L2Columns(id) ON DELETE CASCADE,
      Value TEXT,
      UpdatedBy TEXT,
      UpdatedAt TEXT DEFAULT (datetime('now')),
      Version INTEGER DEFAULT 0,
      UNIQUE(DeviceId, ColumnId)
    );
    CREATE INDEX IF NOT EXISTS idx_l2cells_deviceid ON L2CellValues(DeviceId);

    CREATE TABLE IF NOT EXISTS L2PendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudDeviceId INTEGER NOT NULL,
      CloudColumnId INTEGER NOT NULL,
      Value TEXT,
      UpdatedBy TEXT,
      Version INTEGER DEFAULT 0,
      CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0,
      LastError TEXT
    );

  `)

  // VFD commissioning state is now stored entirely in L2CellValues
  // (columns: "Motor HP (Field)", "VFD HP (Field)", "Ready For Tracking",
  // "Belt Tracked", "Speed Set Up"). The old VfdCheckState table is
  // dropped on startup — any data that was in it is already mirrored in L2.
  try {
    db.exec('DROP TABLE IF EXISTS VfdCheckState')
  } catch {
    // Best-effort — if the drop fails the table is simply unused now.
  }
}

// ── Type definitions ─────────────────────────────────────────────

export interface Io {
  id: number
  SubsystemId: number
  Name: string | null
  Description: string | null
  Result: string | null
  Timestamp: string | null
  Comments: string | null
  Order: number | null
  Version: number
  TagType: string | null
  CloudSyncedAt: string | null
  NetworkDeviceName: string | null
  AssignedTo: string | null
  PunchlistStatus: string | null
  Trade: string | null
  ClarificationNote: string | null
  InstallationStatus: string | null
  InstallationPercent: number | null
  PoweredUp: number | null
  TestedBy: string | null
  IoNumber: string | null
}

export interface TestHistory {
  id: number
  IoId: number
  Result: string | null
  Timestamp: string
  Comments: string | null
  TestedBy: string | null
  State: string | null
  FailureMode: string | null
  Source: string | null
}

export interface User {
  id: number
  FullName: string
  Pin: string
  IsAdmin: number
  IsActive: number
  CreatedAt: string
  LastUsedAt: string | null
}

export interface PendingSync {
  id: number
  IoId: number
  InspectorName: string | null
  TestResult: string | null
  Comments: string | null
  State: string | null
  Timestamp: string | null
  CreatedAt: string
  RetryCount: number
  LastError: string | null
  Version: number
}

// ── Helper constants ─────────────────────────────────────────────

export const TestConstants = {
  RESULT_PASSED: 'Passed',
  RESULT_FAILED: 'Failed',
} as const

// ── Compatibility layer (camelCase accessors for Prisma-style code) ──

/** Convert a raw DB row (PascalCase columns) to camelCase for API responses */
export function ioToApi(row: Io) {
  return {
    id: row.id,
    subsystemId: row.SubsystemId,
    name: row.Name,
    description: row.Description,
    result: row.Result,
    timestamp: row.Timestamp,
    comments: row.Comments,
    order: row.Order,
    version: (row.Version ?? 0).toString(),
    tagType: row.TagType,
    networkDeviceName: row.NetworkDeviceName,
    assignedTo: row.AssignedTo,
    punchlistStatus: row.PunchlistStatus,
    trade: row.Trade,
    clarificationNote: row.ClarificationNote,
    installationStatus: row.InstallationStatus,
    installationPercent: row.InstallationPercent,
    poweredUp: row.PoweredUp === 1 ? true : row.PoweredUp === 0 ? false : null,
    testedBy: row.TestedBy ?? null,
    ioNumber: row.IoNumber ?? null,
  }
}

/** Check database health */
/**
 * Extract the parent network device name from an IO tag name.
 * Handles both formats:
 *   "NCP1_8_VFD:I.In_0"         → "NCP1_8_VFD"    (colon-separated)
 *   "PDP04_FIOM1_X5.PIN4_DI"    → "PDP04_FIOM1"   (FIOM sub-port, _X\d pattern)
 *   "SLOT5_IB16:I.Data.0"       → "SLOT5_IB16"    (local slot module)
 */
export function extractDeviceName(tagName: string): string | null {
  if (!tagName) return null
  // Format 1: colon-separated (most common)
  const colonIdx = tagName.indexOf(':')
  if (colonIdx > 0) return tagName.substring(0, colonIdx)
  // Format 2: FIOM sub-port (_X0-X9 then .PIN or .Communication)
  const fiomMatch = tagName.match(/^(.+?)_X\d/)
  if (fiomMatch) return fiomMatch[1]
  // Format 3: dot-separated without colon (rare)
  const dotIdx = tagName.indexOf('.')
  if (dotIdx > 0) return tagName.substring(0, dotIdx)
  return null
}

export function checkDatabaseHealth(): boolean {
  try {
    db.prepare('SELECT 1').get()
    return true
  } catch {
    return false
  }
}
