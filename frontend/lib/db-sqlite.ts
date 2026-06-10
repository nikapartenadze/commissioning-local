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
    // Per-IO Yes/No flag that mechs/electricians toggle when an IO depends on
    // outside work (third-party deliverable, mech install, etc.). Synced to
    // cloud where it's displayed read-only. NULL = unset (treated as "No").
    'ALTER TABLE Ios ADD COLUMN HasDependencies INTEGER',
    // Latest failure reason, denormalised onto the Ios row so cloud quick
    // filters ("3rd Party", "Mech") can match without joining TestHistories.
    // Set on Fail, cleared on Pass/Clear, untouched on comment-only updates.
    'ALTER TABLE Ios ADD COLUMN FailureMode TEXT',
    'ALTER TABLE L2Columns ADD COLUMN Description TEXT',
    'ALTER TABLE L2Columns ADD COLUMN InputType TEXT',
    'ALTER TABLE L2Columns ADD COLUMN IsSystem INTEGER DEFAULT 0',
    'ALTER TABLE L2Columns ADD COLUMN IsEditable INTEGER DEFAULT 1',
    'ALTER TABLE L2Columns ADD COLUMN IncludeInProgress INTEGER DEFAULT 0',
    'ALTER TABLE TestHistories ADD COLUMN Source TEXT',
    'ALTER TABLE EStopEpcChecks ADD COLUMN FailureMode TEXT',
    // E-Stop dual safety verification: pending-sync rows carry the CheckType
    // discriminator ('preliminary' | 'final') so a final-check result syncs to
    // cloud without colliding with the preliminary one. (EStopEpcChecks itself
    // gets CheckType via the recreate-migration guard below — its inline UNIQUE
    // can't be ALTERed; this pending-sync table has no UNIQUE so a plain ADD
    // COLUMN suffices.)
    "ALTER TABLE EStopCheckPendingSyncs ADD COLUMN CheckType TEXT NOT NULL DEFAULT 'preliminary'",
    // The pending-sync row needs to carry the failure mode so it lands on
    // cloud alongside the rest of the IO update — without this column the
    // cloud sidebar filter has nothing to filter on.
    'ALTER TABLE PendingSyncs ADD COLUMN FailureMode TEXT',
    'ALTER TABLE PendingSyncs ADD COLUMN HasDependencies INTEGER',
    // Blocker assignment carried alongside an Unpass on the sync queue. The
    // canonical store for the two values is the shared Devices row on cloud
    // (the install-tracker's columns); we just need them on the queue so the
    // cloud-sync push can include them. FailureMode column still carries the
    // tester's chosen Failure Reason. The unused legacy BlockerDescription
    // columns on Ios/TestHistories from an earlier design iteration are
    // kept (additive, harmless) — new code does not populate them.
    'ALTER TABLE PendingSyncs ADD COLUMN BlockerResponsibleParty TEXT',
    'ALTER TABLE PendingSyncs ADD COLUMN BlockerDescription TEXT',
    'ALTER TABLE Ios ADD COLUMN BlockerDescription TEXT',
    'ALTER TABLE TestHistories ADD COLUMN BlockerDescription TEXT',
    // Dead-letter flag: a pending row that the cloud permanently rejected, or
    // that exhausted the retry cap, is PARKED (DeadLettered=1) instead of
    // DELETEd. Deleting it left zero trace — the queue count hit 0 and the UI
    // read "synced" while the result never reached cloud (the MCM11 silent-
    // loss class: B3/B5/B7). Parked rows keep the local result + reason, are
    // excluded from the active push loop, and are surfaced as "needs attention".
    'ALTER TABLE PendingSyncs ADD COLUMN DeadLettered INTEGER NOT NULL DEFAULT 0',
    // L2/FV cell sync queue — same dead-letter parity as IO PendingSyncs above.
    // A capped L2 row used to be DELETEd ("cloud probably has it"), silently
    // losing genuinely-unsynced wizard cell values. Park it (DeadLettered=1)
    // instead so the local value + reason survive and the row is excluded from
    // the active push loop and the pull gate.
    'ALTER TABLE L2PendingSyncs ADD COLUMN DeadLettered INTEGER NOT NULL DEFAULT 0',
    // First-run hardening: the seeded default admin (Admin/111111) is flagged
    // MustChangePin=1 so the UI forces a new PIN on first admin login under
    // enforced auth. Additive + backward-safe: existing users default to 0.
    'ALTER TABLE Users ADD COLUMN MustChangePin INTEGER NOT NULL DEFAULT 0',
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }

  // E-Stop dual safety verification — widen EStopEpcChecks' UNIQUE key to
  // include CheckType. SQLite CANNOT ALTER an inline UNIQUE constraint, so a
  // pre-existing table must be RECREATED. This runs on EVERY startup, so it is
  // guarded to be IDEMPOTENT and DATA-PRESERVING:
  //   - Fresh DBs already get the new schema (with CheckType + 4-col UNIQUE)
  //     from initializeSchema() above → the guard finds CheckType and skips.
  //   - Old DBs have EStopEpcChecks WITHOUT CheckType → recreate once: copy all
  //     existing rows tagging them 'preliminary', drop, rename, reindex. After
  //     this runs once CheckType exists, so the guard skips forever.
  try {
    const cols = db.prepare("PRAGMA table_info(EStopEpcChecks)").all() as { name: string }[]
    const tableExists = cols.length > 0
    const hasCheckType = cols.some(c => c.name === 'CheckType')
    if (tableExists && !hasCheckType) {
      console.log('[DB] Migrating EStopEpcChecks: adding CheckType + widening UNIQUE key (recreate)')
      const migrate = db.transaction(() => {
        db.exec(`
          CREATE TABLE EStopEpcChecks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            SubsystemId INTEGER NOT NULL,
            ZoneName TEXT NOT NULL,
            CheckTag TEXT NOT NULL,
            Result TEXT,
            Comments TEXT,
            FailureMode TEXT,
            TestedBy TEXT,
            TestedAt TEXT,
            Version INTEGER NOT NULL DEFAULT 1,
            CreatedAt TEXT DEFAULT (datetime('now')),
            UpdatedAt TEXT,
            CheckType TEXT NOT NULL DEFAULT 'preliminary',
            UNIQUE(SubsystemId, ZoneName, CheckTag, CheckType)
          );
        `)
        // FailureMode may or may not exist on the old table depending on whether
        // the ALTER above already ran — COALESCE via a column list is fragile,
        // so detect it and build the copy list accordingly. All other columns
        // are guaranteed present from the original CREATE TABLE.
        const hadFailureMode = cols.some(c => c.name === 'FailureMode')
        const failureModeSelect = hadFailureMode ? 'FailureMode' : 'NULL'
        db.exec(`
          INSERT INTO EStopEpcChecks_new
            (id, SubsystemId, ZoneName, CheckTag, Result, Comments, FailureMode, TestedBy, TestedAt, Version, CreatedAt, UpdatedAt, CheckType)
          SELECT
            id, SubsystemId, ZoneName, CheckTag, Result, Comments, ${failureModeSelect}, TestedBy, TestedAt, Version, CreatedAt, UpdatedAt, 'preliminary'
          FROM EStopEpcChecks;
        `)
        db.exec('DROP TABLE EStopEpcChecks;')
        db.exec('ALTER TABLE EStopEpcChecks_new RENAME TO EStopEpcChecks;')
        db.exec('CREATE INDEX IF NOT EXISTS idx_estopepcchecks_subsystemid ON EStopEpcChecks(SubsystemId);')
        db.exec('CREATE INDEX IF NOT EXISTS idx_estopepcchecks_checktag ON EStopEpcChecks(CheckTag);')
      })
      migrate()
    }
  } catch (e) {
    console.warn('[DB] EStopEpcChecks CheckType migration failed:', (e as Error).message)
  }

  // PendingSyncs coalesce trigger + active-queue index — created AFTER the
  // migrations so the DeadLettered column is guaranteed to exist (added above
  // on a pre-existing DB, or present in CREATE TABLE on a fresh one). It must
  // NOT live in initializeSchema(): that runs BEFORE the ALTER, so referencing
  // DeadLettered there threw "no such column", aborting the whole schema init
  // and silently skipping every migration (caught in battle pre-release).
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_pendingsyncs_active ON PendingSyncs(DeadLettered, IoId)')
    // F2 coalesce: keep only the LATEST active pending row per IO so rapid
    // repeated edits don't pile up thousands of version-conflicting rows.
    // Parked (DeadLettered=1) rows are left alone (the attention surface).
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_pendingsyncs_coalesce
      AFTER INSERT ON PendingSyncs
      WHEN NEW.DeadLettered = 0
      BEGIN
        DELETE FROM PendingSyncs WHERE IoId = NEW.IoId AND DeadLettered = 0 AND id < NEW.id;
      END`)
  } catch (e) { console.warn('[DB] coalesce trigger/index setup failed:', e) }
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
      LastUsedAt TEXT,
      -- First-run hardening: forces a PIN change on first login (seeded admin).
      MustChangePin INTEGER NOT NULL DEFAULT 0
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
      Version INTEGER DEFAULT 0,
      -- Parked-sync flag (also added by ALTER for pre-existing DBs). Declared
      -- here so a FRESH DB has it immediately and the coalesce trigger/index
      -- below can reference it. See the dead-letter design in auto-sync.ts.
      DeadLettered INTEGER NOT NULL DEFAULT 0
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

    -- Holds the 2026 "Zone Matrix" CSV columns ESTOPs_Must_Drop and
    -- ESTOPs_Must_Stay_OK. Each row is a PLC tag (typically a sibling
    -- VFD's :SI.InNNData pull-cord input) that must either drop with
    -- this EPC (MustDrop=1) or stay healthy during this test (MustDrop=0).
    CREATE TABLE IF NOT EXISTS EStopRelatedEpcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      EpcId INTEGER NOT NULL REFERENCES EStopEpcs(id) ON DELETE CASCADE,
      Tag TEXT NOT NULL,
      MustDrop INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_estoprelatedepcs_epcid ON EStopRelatedEpcs(EpcId);

    -- SCADA MCM layout SVGs pulled from cloud. One row per MCM name. The
    -- local renderer inlines svgContent into the DOM (after DOMPurify) so
    -- guided mode and the "Show on Diagram" panel show device positions
    -- and can highlight the active device by its tag-named element id.
    -- McmName matches Subsystem.name on cloud (e.g. "MCM09").
    CREATE TABLE IF NOT EXISTS McmDiagrams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      McmName TEXT NOT NULL UNIQUE,
      SvgContent TEXT NOT NULL,
      ServerUploadedAt TEXT,
      FetchedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mcmdiagrams_mcmname ON McmDiagrams(McmName);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS Roadmaps (
      Id           INTEGER PRIMARY KEY,
      ProjectId    INTEGER NOT NULL,
      Mcm          TEXT NOT NULL,
      Name         TEXT NOT NULL,
      Description  TEXT,
      StepsJson    TEXT NOT NULL,
      PathJson     TEXT,
      IsPublished  INTEGER NOT NULL DEFAULT 0,
      UpdatedAt    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_roadmaps_mcm ON Roadmaps(Mcm);
  `)

  // Guided-Mode Task Pool: manual status the tester applies to a Task that has
  // no natural data backing (skip-with-reason, or manual "mark done" for
  // network-loop / VFD / functional tasks whose detailed entry lives in the
  // existing specialized views). Data-backed tasks (IO checks, e-stop, L2)
  // derive completion from their underlying rows — this table only records the
  // overrides. Keyed by (SubsystemId, TaskId); TaskId is the deterministic id
  // from lib/guided/task-pool/task-builder.ts so status survives a rebuild.
  db.exec(`
    CREATE TABLE IF NOT EXISTS GuidedTaskState (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      TaskId      TEXT NOT NULL,
      Status      TEXT NOT NULL,            -- 'skipped' | 'completed'
      Reason      TEXT,
      ActorName   TEXT,
      UpdatedAt   TEXT DEFAULT (datetime('now')),
      UNIQUE(SubsystemId, TaskId)
    );
    CREATE INDEX IF NOT EXISTS idx_guidedtaskstate_subsystem ON GuidedTaskState(SubsystemId);
  `)

  db.exec(`
    -- Per-EPC pass/fail test results. Keyed by (SubsystemId, ZoneName, CheckTag)
    -- — NOT by EStopEpcs.id — because the cloud-pull route DELETEs and re-inserts
    -- all EStop* rows on every refresh, which would otherwise wipe test history.
    -- CheckTag is the stable PLC tag name; using it as the identity means results
    -- survive across pulls even if the EStopEpcs.id changes.
    -- CheckType discriminator ('preliminary' | 'final') lets each EPC hold TWO
    -- independent results: the Preliminary "zone stopping" (positive) check and
    -- the Final "selectivity" (negative) check. The UNIQUE key includes
    -- CheckType so a preliminary write and a final write never contend for the
    -- same row/version. FailureMode is declared inline here (also added via the
    -- ALTER list above as a harmless no-op for older DBs). See the migration
    -- guard below — a pre-existing table without CheckType is recreated.
    CREATE TABLE IF NOT EXISTS EStopEpcChecks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      ZoneName TEXT NOT NULL,
      CheckTag TEXT NOT NULL,
      Result TEXT,
      Comments TEXT,
      FailureMode TEXT,
      TestedBy TEXT,
      TestedAt TEXT,
      Version INTEGER NOT NULL DEFAULT 1,
      CreatedAt TEXT DEFAULT (datetime('now')),
      UpdatedAt TEXT,
      CheckType TEXT NOT NULL DEFAULT 'preliminary',
      UNIQUE(SubsystemId, ZoneName, CheckTag, CheckType)
    );
    CREATE INDEX IF NOT EXISTS idx_estopepcchecks_subsystemid ON EStopEpcChecks(SubsystemId);
    CREATE INDEX IF NOT EXISTS idx_estopepcchecks_checktag ON EStopEpcChecks(CheckTag);

    -- Offline push queue for EStop EPC pass/fail results. Mirrors L2PendingSyncs:
    -- a row is enqueued on every /api/estop/check write and drained to the cloud
    -- (POST /api/sync/estop-checks). Identity is the composite
    -- (SubsystemId, ZoneName, CheckTag) — same key as EStopEpcChecks — and Version
    -- carries the EStopEpcChecks.Version at the time of the write so the cloud can
    -- apply last-write-wins. Kept retry-safe: rows survive non-OK pushes for the
    -- periodic background drain (see lib/cloud/auto-sync.ts).
    CREATE TABLE IF NOT EXISTS EStopCheckPendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      ZoneName TEXT NOT NULL,
      CheckTag TEXT NOT NULL,
      Result TEXT,
      Comments TEXT,
      FailureMode TEXT,
      TestedBy TEXT,
      TestedAt TEXT,
      Version INTEGER NOT NULL DEFAULT 0,
      CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0,
      LastError TEXT,
      CheckType TEXT NOT NULL DEFAULT 'preliminary'
    );
    CREATE INDEX IF NOT EXISTS idx_estopcheckpendingsyncs_createdat ON EStopCheckPendingSyncs(CreatedAt);

    -- Offline push queue for Guided-Mode task overrides (skip / mark-done).
    -- A row is enqueued on every /api/guided/tasks/complete and /skip write and
    -- drained to the cloud (POST /api/sync/guided-task-state). Identity is the
    -- composite (SubsystemId, TaskId) — same key as GuidedTaskState — so the
    -- newest queued state for a task supersedes earlier ones. Retry-safe like
    -- EStopCheckPendingSyncs.
    CREATE TABLE IF NOT EXISTS GuidedTaskStatePendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      TaskId TEXT NOT NULL,
      Status TEXT NOT NULL,              -- 'skipped' | 'completed' | 'cleared'
      Reason TEXT,
      ActorName TEXT,
      UpdatedAt TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0,
      LastError TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_guidedtaskstatependingsyncs_createdat ON GuidedTaskStatePendingSyncs(CreatedAt);

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
      LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0
    );

    -- Device-level blocker sync queue (VFD bump-test failures).
    -- Unlike L2PendingSyncs (per IO-cell), this propagates a Party→Description
    -- blocker to the SHARED Devices.Blocker* columns on cloud (resolved there
    -- by ios(subsystem) ⨝ Devices on device_id WHERE Devices.Name = DeviceName).
    -- 'set' writes both columns; 'clear' conditionally nulls them only if the
    -- current cloud values still match the Expected* pair (so a blocker set by
    -- the tracker/coordinator meanwhile is never wiped). See
    -- frontend/specs/2026-06-04-vfd-bump-blocker-design.md.
    CREATE TABLE IF NOT EXISTS DeviceBlockerPendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      DeviceName TEXT NOT NULL,
      Op TEXT NOT NULL,                  -- 'set' | 'clear'
      BlockerResponsibleParty TEXT,
      BlockerDescription TEXT,
      ExpectedParty TEXT,
      ExpectedDescription TEXT,
      UpdatedBy TEXT,
      Timestamp TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0,
      LastError TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deviceblockersyncs_createdat ON DeviceBlockerPendingSyncs(CreatedAt);

  `)

  // VFD commissioning state is now stored entirely in L2CellValues
  // (columns: "Verify Identity", "Motor HP (Field)", "VFD HP (Field)",
  // "Check Direction", "Belt Tracked", "Speed Set Up"). The old VfdCheckState
  // table is dropped on startup — any data that was in it is already mirrored in L2.
  try {
    db.exec('DROP TABLE IF EXISTS VfdCheckState')
  } catch {
    // Best-effort — if the drop fails the table is simply unused now.
  }

  // Step 4 "Controls Verified" has no L2 column — it's a manual confirmation
  // that keypad controls (F0/F1/F2) work. Persisted locally so reopening the
  // wizard remembers the tech already verified controls for this VFD.
  db.exec(`
    CREATE TABLE IF NOT EXISTS VfdControlsVerified (
      deviceName TEXT PRIMARY KEY,
      completedBy TEXT,
      completedAt TEXT DEFAULT (datetime('now'))
    )
  `)
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
  HasDependencies: number | null
  FailureMode: string | null
  BlockerDescription: string | null
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
  BlockerDescription: string | null
}

export interface User {
  id: number
  FullName: string
  Pin: string
  IsAdmin: number
  IsActive: number
  CreatedAt: string
  LastUsedAt: string | null
  MustChangePin?: number
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
  FailureMode: string | null
  HasDependencies: number | null
  BlockerResponsibleParty: string | null
  BlockerDescription: string | null
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
    hasDependencies: row.HasDependencies === 1 ? true : row.HasDependencies === 0 ? false : null,
    failureMode: row.FailureMode ?? null,
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
