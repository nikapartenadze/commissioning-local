/**
 * Phase 2: Data Migration Script
 * Copies data from `prod` database to `autstand` database.
 *
 * Prerequisites:
 *   1. Run 001-schema-migration.sql on autstand FIRST
 *   2. npm install pg (or run from installation-tracker/ which already has it)
 *
 * Usage:
 *   npx tsx scripts/002-data-migration.ts [--dry-run]
 *
 * IMPORTANT: This script READS from prod and WRITES to autstand.
 *            The prod database is never modified.
 */

import pg from 'pg'
const { Client } = pg

// ============================================================================
// Configuration
// ============================================================================

const PROD_DB = {
  host: 'autstandpostgresql.postgres.database.azure.com',
  port: 5432,
  database: 'prod',
  user: 'Sharpness6069',
  password: 'X8RsQamU@3uMEN^u',
  ssl: { rejectUnauthorized: false },
}

const AUTSTAND_DB = {
  host: 'autstandpostgresql.postgres.database.azure.com',
  port: 5432,
  database: 'autstand',
  user: 'Sharpness6069',
  password: 'X8RsQamU@3uMEN^u',
  ssl: { rejectUnauthorized: false },
}

const DRY_RUN = process.argv.includes('--dry-run')

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
    // Step 2A: Build project ID mapping
    // ------------------------------------------------------------------
    log('--- Step 2A: Building project ID mapping ---')

    const prodProjects = await queryProd(prod,
      'SELECT "Id", "Name", "Slug", "Location", "EndUser", "StartDate", "EndDate", "ManifestVersion", "Created" FROM "Projects"'
    )
    log(`  Found ${prodProjects.length} projects in prod`)

    const autstandProjects = (await autstand.query('SELECT id, name FROM projects')).rows
    log(`  Found ${autstandProjects.length} projects in autstand`)

    // Map by name (case-insensitive)
    const projectMap = new Map<number, number>() // prod.Id -> autstand.id
    const unmappedProjects: string[] = []

    for (const pp of prodProjects) {
      const match = autstandProjects.find(
        (ap: { id: number; name: string }) =>
          ap.name.toLowerCase() === pp.Name.toLowerCase()
      )
      if (match) {
        projectMap.set(pp.Id, match.id)
        log(`  Mapped: prod "${pp.Name}" (id=${pp.Id}) -> autstand (id=${match.id})`)
      } else {
        unmappedProjects.push(pp.Name)
        log(`  WARNING: No match for prod project "${pp.Name}" (id=${pp.Id})`)
      }
    }

    if (unmappedProjects.length > 0) {
      log(`\n  ${unmappedProjects.length} unmapped project(s). These will be CREATED in autstand:`)
      for (const name of unmappedProjects) {
        const pp = prodProjects.find((p: { Name: string }) => p.Name === name)!
        if (!DRY_RUN) {
          const result = await autstand.query(
            `INSERT INTO projects (name, slug, location, end_user, start_date, end_date, manifest_version, created, archived)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
             RETURNING id`,
            [pp.Name, pp.Slug, pp.Location, pp.EndUser, pp.StartDate, pp.EndDate, pp.ManifestVersion, pp.Created]
          )
          projectMap.set(pp.Id, result.rows[0].id)
          log(`  Created: "${pp.Name}" -> autstand id=${result.rows[0].id}`)
        } else {
          log(`  [DRY RUN] Would create project "${pp.Name}"`)
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 2B: Update project metadata for mapped projects
    // ------------------------------------------------------------------
    log('\n--- Step 2B: Enriching existing projects with metadata ---')

    for (const pp of prodProjects) {
      const autstandId = projectMap.get(pp.Id)
      if (!autstandId) continue

      if (!DRY_RUN) {
        await autstand.query(
          `UPDATE projects SET
            slug = COALESCE($1, slug),
            location = COALESCE($2, location),
            end_user = COALESCE($3, end_user),
            start_date = COALESCE($4, start_date),
            end_date = COALESCE($5, end_date),
            manifest_version = COALESCE($6, manifest_version),
            created = COALESCE($7, created)
          WHERE id = $8`,
          [pp.Slug, pp.Location, pp.EndUser, pp.StartDate, pp.EndDate, pp.ManifestVersion, pp.Created, autstandId]
        )
      }
      log(`  Updated metadata for project id=${autstandId}`)
    }

    // ------------------------------------------------------------------
    // Step 2C: Migrate Devices
    // ------------------------------------------------------------------
    log('\n--- Step 2C: Migrating Devices ---')

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
      const newProjectId = projectMap.get(d.ProjectId)
      if (!newProjectId) {
        devicesSkipped++
        continue
      }

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
    log(`  Migrated: ${devicesMigrated}, Skipped (unmapped project): ${devicesSkipped}`)

    // Fix sequence
    if (!DRY_RUN) {
      await autstand.query(`SELECT setval(pg_get_serial_sequence('"Devices"', 'Id'), COALESCE((SELECT MAX("Id") FROM "Devices"), 1))`)
    }

    // ------------------------------------------------------------------
    // Step 2D: Migrate install progress tables
    // ------------------------------------------------------------------
    log('\n--- Step 2D: Migrating install progress tables ---')

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
      const selectSql = `SELECT ${quotedCols.join(',')} FROM "${table.name}" ORDER BY "${table.pk}"`
      const rows = await queryProd(prod, selectSql)

      if (rows.length === 0) {
        log(`  ${table.name}: 0 rows (empty)`)
        continue
      }

      if (!DRY_RUN) {
        for (const row of rows) {
          const values = allCols.map(c => row[c])
          const placeholders = allCols.map((_, i) => `$${i + 1}`)
          await autstand.query(
            `INSERT INTO "${table.name}" (${quotedCols.join(',')})
             VALUES (${placeholders.join(',')})
             ON CONFLICT ("${table.pk}") DO NOTHING`,
            values
          )
        }
      }
      log(`  ${table.name}: ${rows.length} rows`)
    }

    // ------------------------------------------------------------------
    // Step 2E: Migrate DailyReports + ReportWorkItems
    // ------------------------------------------------------------------
    log('\n--- Step 2E: Migrating DailyReports ---')

    const reports = await queryProd(prod,
      `SELECT "Id", "CreatedAt", "ProjectId", "Company", "Name", "Contact", "Date",
              "ToolboxTalkAttendance", "ToolboxTalkTopics", "SafetyIncidents",
              "Manpower", "HoursWorked", "OtherWorkAccomplished", "PlannedWorkTasks",
              "JhaComplianceCheckbox", "JhaComplianceVerifierName", "RisksAndIssues"
       FROM "DailyReports" ORDER BY "Id"`
    )

    let reportsMigrated = 0
    for (const r of reports) {
      const newProjectId = projectMap.get(r.ProjectId)
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
    log(`  DailyReports: ${reportsMigrated} migrated`)

    // Fix sequence
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
    log(`  ReportWorkItems: ${workItems.length} migrated`)

    if (!DRY_RUN) {
      await autstand.query(`SELECT setval(pg_get_serial_sequence('"ReportWorkItems"', 'Id'), COALESCE((SELECT MAX("Id") FROM "ReportWorkItems"), 1))`)
    }

    // ------------------------------------------------------------------
    // Step 2F: Migrate ApplicationUsers + UserProjectRoles
    // ------------------------------------------------------------------
    log('\n--- Step 2F: Migrating ApplicationUsers + UserProjectRoles ---')

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

    const roles = await queryProd(prod,
      `SELECT "Id", "UserId", "ProjectId", "Role" FROM "UserProjectRoles" ORDER BY "Id"`
    )

    let rolesMigrated = 0
    for (const r of roles) {
      const newProjectId = projectMap.get(r.ProjectId)
      if (!newProjectId) continue

      if (!DRY_RUN) {
        await autstand.query(
          `INSERT INTO "UserProjectRoles" ("Id","UserId","ProjectId","Role")
          VALUES ($1,$2,$3,$4)
          ON CONFLICT ("Id") DO NOTHING`,
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
    // Step 2G: Migrate access keys into cloud's tables
    // ------------------------------------------------------------------
    log('\n--- Step 2G: Migrating access keys ---')

    const accessKeys = await queryProd(prod,
      `SELECT "Id", "ProjectId", "KeyHash", "KeyPrefix", "Label", "Role",
              "CreatedAt", "ExpiresAt", "LastUsedAt", "UsageCount", "IsActive", "CreatedByEmail"
       FROM "ProjectAccessKeys" ORDER BY "Id"`
    )

    let keysMigrated = 0
    for (const k of accessKeys) {
      const newProjectId = projectMap.get(k.ProjectId)
      if (!newProjectId) continue

      if (!DRY_RUN) {
        // Insert into cloud's snake_case table
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

    // Also migrate AccessKeyProjects junction table
    const akProjects = await queryProd(prod,
      `SELECT "Id", "AccessKeyId", "ProjectId" FROM "AccessKeyProjects" ORDER BY "Id"`
    )
    log(`  AccessKeyProjects: ${akProjects.length} (migration requires key ID mapping - skipping for now)`)

    // ------------------------------------------------------------------
    // Step 2H: Migrate EF Migrations History
    // ------------------------------------------------------------------
    log('\n--- Step 2H: Migrating __EFMigrationsHistory ---')

    const efHistory = await queryProd(prod,
      `SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory"`
    )

    if (!DRY_RUN) {
      for (const h of efHistory) {
        await autstand.query(
          `INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion")
          VALUES ($1, $2) ON CONFLICT ("MigrationId") DO NOTHING`,
          [h.MigrationId, h.ProductVersion]
        )
      }
    }
    log(`  EFMigrationsHistory: ${efHistory.length}`)

    // ------------------------------------------------------------------
    // Step 2I: Migrate TrackerAuditLogs
    // ------------------------------------------------------------------
    log('\n--- Step 2I: Migrating AuditLogs -> TrackerAuditLogs ---')

    const auditLogs = await queryProd(prod,
      `SELECT "Id", "Timestamp", "UserId", "UserName", "UserEmail", "Action",
              "DeviceId", "ProjectId", "DashboardTableName", "FieldName",
              "ValueBefore", "ValueAfter", "ReportId", "Details"
       FROM "AuditLogs" ORDER BY "Id"`
    )

    let auditsMigrated = 0
    for (const a of auditLogs) {
      const newProjectId = a.ProjectId ? projectMap.get(a.ProjectId) : null

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
    // Step 2J: Populate ios.device_id (cross-link)
    // ------------------------------------------------------------------
    log('\n--- Step 2J: Populating ios.device_id ---')

    if (!DRY_RUN) {
      const result = await autstand.query(`
        UPDATE ios
        SET device_id = d."Id"
        FROM "Devices" d
        JOIN subsystems s ON s.id = ios.subsystemid
        JOIN projects p ON p.id = s.project_id
        WHERE d."ProjectId" = p.id
          AND d."Name" = SPLIT_PART(ios.name, ':', 1)
          AND ios.device_id IS NULL
      `)
      log(`  Linked ${result.rowCount} IOs to devices`)

      // Check coverage
      const total = (await autstand.query(`SELECT COUNT(*) as c FROM ios WHERE name LIKE '%:%'`)).rows[0].c
      const linked = (await autstand.query(`SELECT COUNT(*) as c FROM ios WHERE device_id IS NOT NULL`)).rows[0].c
      const unlinked = (await autstand.query(`SELECT COUNT(*) as c FROM ios WHERE device_id IS NULL AND name LIKE '%:%'`)).rows[0].c
      log(`  Coverage: ${linked}/${total} IOs linked (${unlinked} unlinked with ':' pattern)`)
    } else {
      log(`  [DRY RUN] Would populate ios.device_id via SPLIT_PART join`)
    }

    // ------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------
    log('\n=== Migration Complete ===')
    log(`  Projects mapped: ${projectMap.size}`)
    log(`  Devices: ${devicesMigrated}`)
    log(`  Reports: ${reportsMigrated}`)
    log(`  Users: ${users.length}`)
    log(`  Access Keys: ${keysMigrated}`)
    log(`  Audit Logs: ${auditsMigrated}`)
    if (DRY_RUN) {
      log('\n  This was a DRY RUN. No data was written.')
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
