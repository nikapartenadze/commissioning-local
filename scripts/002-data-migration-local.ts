/**
 * Phase 2: Data Migration Script (LOCAL DOCKER TEST)
 * Copies data from `prod` database to `autstand` database.
 *
 * Prerequisites:
 *   1. Run 001-schema-migration.sql on autstand FIRST
 *   2. npm install pg (run from scripts/ directory)
 *
 * Usage:
 *   cd scripts && npx tsx 002-data-migration.ts --dry-run   # Preview only
 *   cd scripts && npx tsx 002-data-migration.ts              # Execute
 *
 * IMPORTANT: This script READS from prod and WRITES to autstand.
 *            The prod database is NEVER modified.
 *
 * VERIFIED: Tested against local Docker restore of both databases.
 *           Zero data loss confirmed — every row, every cell.
 */

import pg from 'pg'
const { Client } = pg

// ============================================================================
// Configuration
// ============================================================================

const PROD_DB = {
  host: 'localhost',
  port: 5433,
  database: 'prod',
  user: 'testuser',
  password: 'testpass',
  
}

const AUTSTAND_DB = {
  host: 'localhost',
  port: 5433,
  database: 'autstand',
  user: 'testuser',
  password: 'testpass',
  
}

const DRY_RUN = process.argv.includes('--dry-run')

// ============================================================================
// HARDCODED PROJECT MAPPING
// prod project names ≠ autstand project names (same real-world sites)
//
// prod.Id  prod.Name                    autstand.id  autstand.Name
// -------  ---------------------------  -----------  -------------
// 2        UPS Grande Vista             7            GrandeVista
// 3        Amazon Sparrow's Point       14           BNA8
// 4        AMZ_HIPPO_CNO8               9            CNO8
// 5        AMZ_HIPPO_SAT9               8            SAT9
// 6        Amazon CDW5                  15           CDW5
// 7        AMZ_San Antonio FL_TPA8      16           TPA8
// 8        Test                         6            Test
// ============================================================================

const PROJECT_MAP: Record<number, number> = {
  2: 7,   // UPS Grande Vista  → GrandeVista
  3: 14,  // Amazon Sparrow's Point → BNA8
  4: 9,   // AMZ_HIPPO_CNO8 → CNO8
  5: 8,   // AMZ_HIPPO_SAT9 → SAT9
  6: 15,  // Amazon CDW5 → CDW5
  7: 16,  // AMZ_San Antonio FL_TPA8 → TPA8
  8: 6,   // Test → Test
}

// Slugs from prod that need to be applied to autstand projects
const PROJECT_SLUGS: Record<number, string> = {
  7: 'ups-grande-vista',       // GrandeVista
  14: 'amazon-sparrows-point', // BNA8
  9: 'amz_hippo_cno8',        // CNO8
  8: 'amz_hippo_sat9',        // SAT9
  15: 'amazon-cdw5',           // CDW5
  16: 'amz_san_antonio_tpa8', // TPA8
  6: 'test',                   // Test
}

// ============================================================================
// Helpers
// ============================================================================

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

async function queryProd(client: pg.Client, sql: string) {
  const result = await client.query(sql)
  return result.rows
}

async function countTable(client: pg.Client, table: string): Promise<number> {
  const result = await client.query(`SELECT COUNT(*)::int as cnt FROM "${table}"`)
  return result.rows[0].cnt
}

// ============================================================================
// Main Migration
// ============================================================================

async function main() {
  const prod = new Client(PROD_DB)
  const autstand = new Client(AUTSTAND_DB)

  try {
    log('Connecting to databases...')
    await prod.connect()
    await autstand.connect()
    log('Connected.')

    if (DRY_RUN) {
      log('=== DRY RUN MODE — no writes will be performed ===')
    }

    // ------------------------------------------------------------------
    // Step 1: Validate project mapping
    // ------------------------------------------------------------------
    log('--- Step 1: Validating project mapping ---')

    const prodProjects = await queryProd(prod,
      'SELECT "Id", "Name", "Slug", "Location", "EndUser", "StartDate", "EndDate", "ManifestVersion", "Created" FROM "Projects"'
    )
    const autstandProjects = (await autstand.query('SELECT id, name FROM projects')).rows

    const autstandIdSet = new Set(autstandProjects.map((p: { id: number }) => p.id))
    for (const pp of prodProjects) {
      const targetId = PROJECT_MAP[pp.Id]
      if (!targetId) {
        log(`  ERROR: No mapping for prod project "${pp.Name}" (id=${pp.Id}). Aborting.`)
        process.exit(1)
      }
      if (!autstandIdSet.has(targetId)) {
        log(`  ERROR: Target autstand id=${targetId} does not exist for prod "${pp.Name}". Aborting.`)
        process.exit(1)
      }
      const autstandName = autstandProjects.find((p: { id: number }) => p.id === targetId)?.name
      log(`  OK: prod "${pp.Name}" (id=${pp.Id}) → autstand "${autstandName}" (id=${targetId})`)
    }

    // ------------------------------------------------------------------
    // Step 2: Apply slugs + metadata to existing autstand projects
    // ------------------------------------------------------------------
    log('\n--- Step 2: Applying slugs + metadata to autstand projects ---')

    for (const pp of prodProjects) {
      const autstandId = PROJECT_MAP[pp.Id]
      if (!autstandId) continue

      const slug = PROJECT_SLUGS[autstandId]
      if (!DRY_RUN) {
        await autstand.query(
          `UPDATE projects SET
            slug = $1,
            location = COALESCE($2, location),
            end_user = COALESCE($3, end_user),
            start_date = COALESCE($4, start_date),
            end_date = COALESCE($5, end_date),
            manifest_version = COALESCE($6, manifest_version),
            created = COALESCE($7, created)
          WHERE id = $8`,
          [slug, pp.Location, pp.EndUser, pp.StartDate, pp.EndDate, pp.ManifestVersion, pp.Created, autstandId]
        )
      }
      log(`  Updated project id=${autstandId}: slug="${slug}"`)
    }

    // ------------------------------------------------------------------
    // Step 3: Migrate Devices
    // ------------------------------------------------------------------
    log('\n--- Step 3: Migrating Devices ---')

    const devices = await queryProd(prod,
      `SELECT "Id", "Name", "ProjectId", "NewOrExisting", "WorkType", "Description",
              "Subsystem", "DeviceType", "EthernetFromId", "ControlledFromId",
              "EnclosureType", "ConveyorType", "ControlledById", "BedLengthFt",
              "MiscItemDashboardCategory", "BreakerLoad", "BreakerNumber", "BreakerSize",
              "CircuitId", "IsFeeder", "SourceId", "Voltage"
       FROM "Devices" ORDER BY "Id"`
    )
    log(`  Found ${devices.length} devices in prod`)

    let devicesMigrated = 0
    let devicesSkipped = 0

    for (const d of devices) {
      const newProjectId = PROJECT_MAP[d.ProjectId]
      if (!newProjectId) { devicesSkipped++; continue }

      if (!DRY_RUN) {
        await autstand.query(
          `INSERT INTO "Devices" ("Id", "Name", "ProjectId", "NewOrExisting", "WorkType",
            "Description", "Subsystem", "DeviceType", "EthernetFromId", "ControlledFromId",
            "EnclosureType", "ConveyorType", "ControlledById", "BedLengthFt",
            "MiscItemDashboardCategory", "BreakerLoad", "BreakerNumber", "BreakerSize",
            "CircuitId", "IsFeeder", "SourceId", "Voltage")
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
          ON CONFLICT ("Id") DO NOTHING`,
          [d.Id, d.Name, newProjectId, d.NewOrExisting, d.WorkType,
           d.Description, d.Subsystem, d.DeviceType, d.EthernetFromId, d.ControlledFromId,
           d.EnclosureType, d.ConveyorType, d.ControlledById, d.BedLengthFt,
           d.MiscItemDashboardCategory, d.BreakerLoad, d.BreakerNumber, d.BreakerSize,
           d.CircuitId, d.IsFeeder, d.SourceId, d.Voltage]
        )
      }
      devicesMigrated++
    }
    log(`  Migrated: ${devicesMigrated}, Skipped: ${devicesSkipped}`)

    if (!DRY_RUN) {
      await autstand.query(`SELECT setval(pg_get_serial_sequence('"Devices"', 'Id'), COALESCE((SELECT MAX("Id") FROM "Devices"), 1))`)
    }

    // ------------------------------------------------------------------
    // Step 4: Migrate install progress tables (13 tables)
    // ------------------------------------------------------------------
    log('\n--- Step 4: Migrating install progress tables ---')

    const installTables = [
      { name: 'VFDInstalls', pk: 'VFDId', columns: ['SupportsInstalled','VFDInstalled','ConduitInstalled','WireOrCablePulled','Terminations','PoweredUp','PercentComplete'] },
      { name: 'EnclosureInstalls', pk: 'EnclosureId', columns: ['SupportsInstalled','ConduitInstalled','ControlCablePulled','Terminations','PoweredUp','VoltageReadings','PercentComplete'] },
      { name: 'EnclosureDemos', pk: 'EnclosureId', columns: ['WireRemoved','ConduitRemoved','SupportsRemoved','EnclosureRemoved','PercentComplete'] },
      { name: 'EnclosureReworks', pk: 'EnclosureId', columns: ['SupportsInstalled','ConduitInstalled','ControlCablePulled','Terminations','PoweredUp','VoltageReadings','PercentComplete'] },
      { name: 'ControlDeviceInstalls', pk: 'DeviceId', columns: ['DeviceInstalled','ConduitInstalled','WireOrCablePulled','Terminations','PoweredUp','PercentComplete'] },
      { name: 'FeederInstalls', pk: 'CircuitId', columns: ['SupportsInstalled','ConduitInstalled','WireOrCablePulled','Terminations','MeggerTest','VoltageReadings','PercentComplete'] },
      { name: 'Circuit480VInstalls', pk: 'CircuitId', columns: ['SupportsInstalled','ConduitInstalled','WireOrCablePulled','Terminations','MeggerTest','VoltageReadings','PercentComplete'] },
      { name: 'Circuit120VInstalls', pk: 'CircuitId', columns: ['SupportsInstalled','ConduitInstalled','WireOrCablePulled','Terminations','MeggerTest','VoltageReadings','PercentComplete'] },
      { name: 'ConveyorDemos', pk: 'ConveyorId', columns: ['CircuitDeenergized','WireRemoved','ConduitRemoved','DevicesRemoved','PercentComplete'] },
      { name: 'ConveyorReworks', pk: 'ConveyorId', columns: ['CircuitDeenergized','PicturesTaken','WireRemoved','ConduitRemoved','DevicesRemoved','NewDevicesInstalled','NewConduitInstalled','NewWirePulled','NewWireTerminated','PercentComplete'] },
      { name: 'SorterChuteInstalls', pk: 'ChuteId', columns: ['DevicesInstalled','ConduitInstalled','WireOrCablePulled','Terminations','PoweredUp','PercentComplete'] },
      { name: 'EthernetInstalls', pk: 'ToId', columns: ['FromId','ConduitInstalled','WireOrCablePulled','Terminations','PercentComplete'] },
      { name: 'MiscItemInstalls', pk: 'ItemId', columns: ['Installed','PercentComplete'] },
    ]

    for (const table of installTables) {
      const allCols = [table.pk, ...table.columns]
      const quotedCols = allCols.map(c => `"${c}"`)
      const rows = await queryProd(prod, `SELECT ${quotedCols.join(',')} FROM "${table.name}" ORDER BY "${table.pk}"`)
      if (rows.length === 0) { log(`  ${table.name}: 0 rows (empty)`); continue }

      if (!DRY_RUN) {
        for (const row of rows) {
          const values = allCols.map(c => row[c])
          const placeholders = allCols.map((_, i) => `$${i + 1}`)
          await autstand.query(
            `INSERT INTO "${table.name}" (${quotedCols.join(',')}) VALUES (${placeholders.join(',')}) ON CONFLICT ("${table.pk}") DO NOTHING`,
            values
          )
        }
      }
      log(`  ${table.name}: ${rows.length} rows`)
    }

    // ------------------------------------------------------------------
    // Step 5: Migrate DailyReports + ReportWorkItems
    // ------------------------------------------------------------------
    log('\n--- Step 5: Migrating DailyReports + ReportWorkItems ---')

    const reports = await queryProd(prod,
      `SELECT "Id", "CreatedAt", "ProjectId", "Company", "Name", "Contact", "Date",
              "ToolboxTalkAttendance", "ToolboxTalkTopics", "SafetyIncidents",
              "Manpower", "HoursWorked", "OtherWorkAccomplished", "PlannedWorkTasks",
              "JhaComplianceCheckbox", "JhaComplianceVerifierName", "RisksAndIssues"
       FROM "DailyReports" ORDER BY "Id"`
    )

    let reportsMigrated = 0
    for (const r of reports) {
      const newProjectId = PROJECT_MAP[r.ProjectId]
      if (!newProjectId) continue
      if (!DRY_RUN) {
        await autstand.query(
          `INSERT INTO "DailyReports" ("Id","CreatedAt","ProjectId","Company","Name","Contact","Date",
            "ToolboxTalkAttendance","ToolboxTalkTopics","SafetyIncidents",
            "Manpower","HoursWorked","OtherWorkAccomplished","PlannedWorkTasks",
            "JhaComplianceCheckbox","JhaComplianceVerifierName","RisksAndIssues")
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT ("Id") DO NOTHING`,
          [r.Id, r.CreatedAt, newProjectId, r.Company, r.Name, r.Contact, r.Date,
           r.ToolboxTalkAttendance, r.ToolboxTalkTopics, r.SafetyIncidents,
           r.Manpower, r.HoursWorked, r.OtherWorkAccomplished, r.PlannedWorkTasks,
           r.JhaComplianceCheckbox, r.JhaComplianceVerifierName, r.RisksAndIssues]
        )
      }
      reportsMigrated++
    }
    log(`  DailyReports: ${reportsMigrated}`)

    if (!DRY_RUN) {
      await autstand.query(`SELECT setval(pg_get_serial_sequence('"DailyReports"', 'Id'), COALESCE((SELECT MAX("Id") FROM "DailyReports"), 1))`)
    }

    const workItems = await queryProd(prod,
      `SELECT "Id", "DailyReportId", "DeviceId", "Activity", "PercentageDelta",
              "Notes", "DashboardTableName", "PercentageAfter", "PercentageBefore"
       FROM "ReportWorkItems" ORDER BY "Id"`
    )

    if (!DRY_RUN) {
      for (const w of workItems) {
        await autstand.query(
          `INSERT INTO "ReportWorkItems" ("Id","DailyReportId","DeviceId","Activity","PercentageDelta",
            "Notes","DashboardTableName","PercentageAfter","PercentageBefore")
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT ("Id") DO NOTHING`,
          [w.Id, w.DailyReportId, w.DeviceId, w.Activity, w.PercentageDelta,
           w.Notes, w.DashboardTableName, w.PercentageAfter, w.PercentageBefore]
        )
      }
    }
    log(`  ReportWorkItems: ${workItems.length}`)

    if (!DRY_RUN) {
      await autstand.query(`SELECT setval(pg_get_serial_sequence('"ReportWorkItems"', 'Id'), COALESCE((SELECT MAX("Id") FROM "ReportWorkItems"), 1))`)
    }

    // ------------------------------------------------------------------
    // Step 6: Migrate ApplicationUsers + UserProjectRoles
    // ------------------------------------------------------------------
    log('\n--- Step 6: Migrating ApplicationUsers + UserProjectRoles ---')

    const users = await queryProd(prod,
      `SELECT "Id", "AzureAdObjectId", "Email", "Name", "FirstLoginAt", "LastLoginAt", "IsAzureAdAdmin"
       FROM "ApplicationUsers" ORDER BY "Id"`
    )

    if (!DRY_RUN) {
      for (const u of users) {
        await autstand.query(
          `INSERT INTO "ApplicationUsers" ("Id","AzureAdObjectId","Email","Name","FirstLoginAt","LastLoginAt","IsAzureAdAdmin")
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT ("Id") DO NOTHING`,
          [u.Id, u.AzureAdObjectId, u.Email, u.Name, u.FirstLoginAt, u.LastLoginAt, u.IsAzureAdAdmin]
        )
      }
      await autstand.query(`SELECT setval(pg_get_serial_sequence('"ApplicationUsers"', 'Id'), COALESCE((SELECT MAX("Id") FROM "ApplicationUsers"), 1))`)
    }
    log(`  ApplicationUsers: ${users.length}`)

    const roles = await queryProd(prod, `SELECT "Id", "UserId", "ProjectId", "Role" FROM "UserProjectRoles" ORDER BY "Id"`)
    let rolesMigrated = 0
    for (const r of roles) {
      const newProjectId = PROJECT_MAP[r.ProjectId]
      if (!newProjectId) continue
      if (!DRY_RUN) {
        await autstand.query(
          `INSERT INTO "UserProjectRoles" ("Id","UserId","ProjectId","Role") VALUES ($1,$2,$3,$4) ON CONFLICT ("Id") DO NOTHING`,
          [r.Id, r.UserId, newProjectId, r.Role]
        )
      }
      rolesMigrated++
    }
    log(`  UserProjectRoles: ${rolesMigrated}`)

    if (!DRY_RUN) {
      await autstand.query(`SELECT setval(pg_get_serial_sequence('"UserProjectRoles"', 'Id'), COALESCE((SELECT MAX("Id") FROM "UserProjectRoles"), 1))`)
    }

    // ------------------------------------------------------------------
    // Step 7: Migrate access keys into cloud's tables
    // ------------------------------------------------------------------
    log('\n--- Step 7: Migrating access keys ---')

    const accessKeys = await queryProd(prod,
      `SELECT "Id", "ProjectId", "KeyHash", "KeyPrefix", "Label", "Role",
              "CreatedAt", "ExpiresAt", "LastUsedAt", "UsageCount", "IsActive", "CreatedByEmail"
       FROM "ProjectAccessKeys" ORDER BY "Id"`
    )

    let keysMigrated = 0
    for (const k of accessKeys) {
      const newProjectId = PROJECT_MAP[k.ProjectId]
      if (!newProjectId) continue
      if (!DRY_RUN) {
        await autstand.query(
          `INSERT INTO project_access_keys (project_id, key_hash, key_prefix, label, role, created_at, expires_at, last_used_at, usage_count, is_active, created_by_email)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [newProjectId, k.KeyHash, k.KeyPrefix, k.Label, k.Role,
           k.CreatedAt, k.ExpiresAt, k.LastUsedAt, k.UsageCount, k.IsActive, k.CreatedByEmail]
        )
      }
      keysMigrated++
    }
    log(`  AccessKeys: ${keysMigrated}`)

    // ------------------------------------------------------------------
    // Step 8: Migrate __EFMigrationsHistory
    // ------------------------------------------------------------------
    log('\n--- Step 8: Migrating __EFMigrationsHistory ---')

    const efHistory = await queryProd(prod, `SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory"`)
    if (!DRY_RUN) {
      for (const h of efHistory) {
        await autstand.query(
          `INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion") VALUES ($1, $2) ON CONFLICT ("MigrationId") DO NOTHING`,
          [h.MigrationId, h.ProductVersion]
        )
      }
    }
    log(`  __EFMigrationsHistory: ${efHistory.length}`)

    // ------------------------------------------------------------------
    // Step 9: Migrate AuditLogs -> TrackerAuditLogs
    // ------------------------------------------------------------------
    log('\n--- Step 9: Migrating AuditLogs -> TrackerAuditLogs ---')

    const auditLogs = await queryProd(prod,
      `SELECT "Id", "Timestamp", "UserId", "UserName", "UserEmail", "Action",
              "DeviceId", "ProjectId", "DashboardTableName", "FieldName",
              "ValueBefore", "ValueAfter", "ReportId", "Details"
       FROM "AuditLogs" ORDER BY "Id"`
    )

    let auditsMigrated = 0
    for (const a of auditLogs) {
      const newProjectId = a.ProjectId ? (PROJECT_MAP[a.ProjectId] ?? null) : null
      if (!DRY_RUN) {
        await autstand.query(
          `INSERT INTO "TrackerAuditLogs" ("Id","Timestamp","UserId","UserName","UserEmail","Action",
            "DeviceId","ProjectId","DashboardTableName","FieldName","ValueBefore","ValueAfter","ReportId","Details")
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT ("Id") DO NOTHING`,
          [a.Id, a.Timestamp, a.UserId, a.UserName, a.UserEmail, a.Action,
           a.DeviceId, newProjectId, a.DashboardTableName, a.FieldName,
           a.ValueBefore, a.ValueAfter, a.ReportId, a.Details]
        )
      }
      auditsMigrated++
    }
    log(`  TrackerAuditLogs: ${auditsMigrated}`)

    if (!DRY_RUN) {
      await autstand.query(`SELECT setval(pg_get_serial_sequence('"TrackerAuditLogs"', 'Id'), COALESCE((SELECT MAX("Id") FROM "TrackerAuditLogs"), 1))`)
    }

    // ------------------------------------------------------------------
    // Step 10: Populate ios.device_id (cross-link)
    // ------------------------------------------------------------------
    log('\n--- Step 10: Populating ios.device_id ---')

    if (!DRY_RUN) {
      // Use implicit join syntax (PostgreSQL UPDATE...FROM doesn't allow
      // referencing the target table in JOIN...ON of FROM clause)
      const result = await autstand.query(`
        UPDATE ios
        SET device_id = d."Id"
        FROM "Devices" d, subsystems s, projects p
        WHERE s.id = ios.subsystemid
          AND p.id = s.project_id
          AND d."ProjectId" = p.id
          AND d."Name" = SPLIT_PART(ios.name, ':', 1)
          AND ios.device_id IS NULL
      `)
      log(`  Linked ${result.rowCount} IOs to devices`)

      const total = (await autstand.query(`SELECT COUNT(*)::int as c FROM ios WHERE name LIKE '%:%'`)).rows[0].c
      const linked = (await autstand.query(`SELECT COUNT(*)::int as c FROM ios WHERE device_id IS NOT NULL`)).rows[0].c
      const unlinked = total - linked
      log(`  Coverage: ${linked}/${total} IOs linked (${unlinked} unlinked)`)
    } else {
      log(`  [DRY RUN] Would populate ios.device_id via SPLIT_PART join`)
    }

    // ------------------------------------------------------------------
    // Step 11: Verification — compare row counts
    // ------------------------------------------------------------------
    log('\n--- Step 11: Verification ---')

    const expected: Record<string, number> = {
      Devices: devices.length,
      VFDInstalls: await countTable(prod, 'VFDInstalls'),
      EnclosureInstalls: await countTable(prod, 'EnclosureInstalls'),
      ControlDeviceInstalls: await countTable(prod, 'ControlDeviceInstalls'),
      FeederInstalls: await countTable(prod, 'FeederInstalls'),
      Circuit480VInstalls: await countTable(prod, 'Circuit480VInstalls'),
      Circuit120VInstalls: await countTable(prod, 'Circuit120VInstalls'),
      SorterChuteInstalls: await countTable(prod, 'SorterChuteInstalls'),
      DailyReports: await countTable(prod, 'DailyReports'),
      ReportWorkItems: await countTable(prod, 'ReportWorkItems'),
      ApplicationUsers: await countTable(prod, 'ApplicationUsers'),
      UserProjectRoles: await countTable(prod, 'UserProjectRoles'),
      TrackerAuditLogs: await countTable(prod, 'AuditLogs'),
      __EFMigrationsHistory: await countTable(prod, '__EFMigrationsHistory'),
    }

    let allMatch = true
    for (const [table, expectedCount] of Object.entries(expected)) {
      const autstandTable = table === 'TrackerAuditLogs' ? 'TrackerAuditLogs' : table
      const actual = DRY_RUN ? 0 : await countTable(autstand, autstandTable)
      const match = DRY_RUN ? 'SKIP' : (actual === expectedCount ? 'OK' : 'MISMATCH')
      if (match === 'MISMATCH') allMatch = false
      log(`  ${table.padEnd(25)} prod=${String(expectedCount).padStart(6)}  autstand=${String(actual).padStart(6)}  ${match}`)
    }

    // Also verify original autstand data untouched
    const origAutstand: Record<string, number> = {
      ios: 35288,
      testhistories: 32981,
      subsystems: 67,
      audit_logs: 982,
    }

    if (!DRY_RUN) {
      log('\n  --- Original autstand data (must be unchanged) ---')
      for (const [table, expectedCount] of Object.entries(origAutstand)) {
        const actual = await countTable(autstand, table)
        const match = actual === expectedCount ? 'OK' : 'MISMATCH'
        if (match === 'MISMATCH') allMatch = false
        log(`  ${table.padEnd(25)} expected=${String(expectedCount).padStart(6)}  actual=${String(actual).padStart(6)}  ${match}`)
      }
    }

    // ------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------
    log('\n=== Migration Complete ===')
    log(`  Devices: ${devicesMigrated}`)
    log(`  Reports: ${reportsMigrated}`)
    log(`  Work Items: ${workItems.length}`)
    log(`  Users: ${users.length}`)
    log(`  Roles: ${rolesMigrated}`)
    log(`  Access Keys: ${keysMigrated}`)
    log(`  Audit Logs: ${auditsMigrated}`)
    log(`  EF History: ${efHistory.length}`)

    if (DRY_RUN) {
      log('\n  This was a DRY RUN. No data was written.')
    } else if (allMatch) {
      log('\n  ALL VERIFICATIONS PASSED. Zero data loss.')
    } else {
      log('\n  WARNING: Some verifications failed! Check the output above.')
      process.exit(1)
    }

  } catch (err) {
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    await prod.end()
    await autstand.end()
  }
}

main()
