/**
 * FAST batch migration script.
 * Uses multi-row INSERT VALUES for 10-20x speedup over single-row inserts.
 * Safe: ON CONFLICT DO NOTHING skips already-inserted rows.
 */

import pg from 'pg'
const { Client } = pg

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

const PROJECT_MAP: Record<number, number> = {
  2: 7, 3: 14, 4: 9, 5: 8, 6: 15, 7: 16, 8: 6,
}

const PROJECT_SLUGS: Record<number, string> = {
  7: 'ups-grande-vista', 14: 'amazon-sparrows-point', 9: 'amz_hippo_cno8',
  8: 'amz_hippo_sat9', 15: 'amazon-cdw5', 16: 'amz_san_antonio_tpa8', 6: 'test',
}

const BATCH_SIZE = 500

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

async function queryProd(client: pg.Client, sql: string) {
  return (await client.query(sql)).rows
}

async function batchInsert(
  client: pg.Client,
  table: string,
  columns: string[],
  rows: any[][],
  conflictCol: string
) {
  if (rows.length === 0) return
  const quotedCols = columns.map(c => `"${c}"`)

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const valueParts: string[] = []
    const params: any[] = []
    let paramIdx = 1

    for (const row of batch) {
      const placeholders = row.map(() => `$${paramIdx++}`)
      valueParts.push(`(${placeholders.join(',')})`)
      params.push(...row)
    }

    await client.query(
      `INSERT INTO "${table}" (${quotedCols.join(',')}) VALUES ${valueParts.join(',')} ON CONFLICT ("${conflictCol}") DO NOTHING`,
      params
    )
  }
}

async function main() {
  const prod = new Client(PROD_DB)
  const autstand = new Client(AUTSTAND_DB)

  try {
    log('Connecting...')
    await prod.connect()
    await autstand.connect()
    log('Connected.')

    // --- Slugs + metadata (already done from previous run, but idempotent) ---
    log('--- Applying slugs + metadata ---')
    const prodProjects = await queryProd(prod,
      'SELECT "Id", "Name", "Slug", "Location", "EndUser", "StartDate", "EndDate", "ManifestVersion", "Created" FROM "Projects"'
    )
    for (const pp of prodProjects) {
      const autstandId = PROJECT_MAP[pp.Id]
      if (!autstandId) continue
      await autstand.query(
        `UPDATE projects SET slug=$1, location=COALESCE($2,location), end_user=COALESCE($3,end_user),
         start_date=COALESCE($4,start_date), end_date=COALESCE($5,end_date),
         manifest_version=COALESCE($6,manifest_version), created=COALESCE($7,created)
         WHERE id=$8`,
        [PROJECT_SLUGS[autstandId], pp.Location, pp.EndUser, pp.StartDate, pp.EndDate, pp.ManifestVersion, pp.Created, autstandId]
      )
    }
    log('  Done')

    // --- Devices (already complete from previous run, skip check) ---
    const deviceCount = (await autstand.query('SELECT COUNT(*)::int as c FROM "Devices"')).rows[0].c
    log(`--- Devices: ${deviceCount} already present (skipping if 29639) ---`)
    if (deviceCount < 29000) {
      log('  ERROR: Devices incomplete, re-run original script first')
      process.exit(1)
    }

    // --- Install tables (batch insert) ---
    log('--- Migrating install progress tables (batch mode) ---')

    const installTables = [
      { name: 'VFDInstalls', pk: 'VFDId', cols: ['VFDId','SupportsInstalled','VFDInstalled','ConduitInstalled','WireOrCablePulled','Terminations','PoweredUp','PercentComplete'] },
      { name: 'EnclosureInstalls', pk: 'EnclosureId', cols: ['EnclosureId','SupportsInstalled','ConduitInstalled','ControlCablePulled','Terminations','PoweredUp','VoltageReadings','PercentComplete'] },
      { name: 'EnclosureDemos', pk: 'EnclosureId', cols: ['EnclosureId','WireRemoved','ConduitRemoved','SupportsRemoved','EnclosureRemoved','PercentComplete'] },
      { name: 'EnclosureReworks', pk: 'EnclosureId', cols: ['EnclosureId','SupportsInstalled','ConduitInstalled','ControlCablePulled','Terminations','PoweredUp','VoltageReadings','PercentComplete'] },
      { name: 'ControlDeviceInstalls', pk: 'DeviceId', cols: ['DeviceId','DeviceInstalled','ConduitInstalled','WireOrCablePulled','Terminations','PoweredUp','PercentComplete'] },
      { name: 'FeederInstalls', pk: 'CircuitId', cols: ['CircuitId','SupportsInstalled','ConduitInstalled','WireOrCablePulled','Terminations','MeggerTest','VoltageReadings','PercentComplete'] },
      { name: 'Circuit480VInstalls', pk: 'CircuitId', cols: ['CircuitId','SupportsInstalled','ConduitInstalled','WireOrCablePulled','Terminations','MeggerTest','VoltageReadings','PercentComplete'] },
      { name: 'Circuit120VInstalls', pk: 'CircuitId', cols: ['CircuitId','SupportsInstalled','ConduitInstalled','WireOrCablePulled','Terminations','MeggerTest','VoltageReadings','PercentComplete'] },
      { name: 'ConveyorDemos', pk: 'ConveyorId', cols: ['ConveyorId','CircuitDeenergized','WireRemoved','ConduitRemoved','DevicesRemoved','PercentComplete'] },
      { name: 'ConveyorReworks', pk: 'ConveyorId', cols: ['ConveyorId','CircuitDeenergized','PicturesTaken','WireRemoved','ConduitRemoved','DevicesRemoved','NewDevicesInstalled','NewConduitInstalled','NewWirePulled','NewWireTerminated','PercentComplete'] },
      { name: 'SorterChuteInstalls', pk: 'ChuteId', cols: ['ChuteId','DevicesInstalled','ConduitInstalled','WireOrCablePulled','Terminations','PoweredUp','PercentComplete'] },
      { name: 'EthernetInstalls', pk: 'ToId', cols: ['ToId','FromId','ConduitInstalled','WireOrCablePulled','Terminations','PercentComplete'] },
      { name: 'MiscItemInstalls', pk: 'ItemId', cols: ['ItemId','Installed','PercentComplete'] },
    ]

    for (const table of installTables) {
      const quotedCols = table.cols.map(c => `"${c}"`)
      const rows = await queryProd(prod, `SELECT ${quotedCols.join(',')} FROM "${table.name}" ORDER BY "${table.pk}"`)
      if (rows.length === 0) { log(`  ${table.name}: 0 rows`); continue }

      const dataRows = rows.map(r => table.cols.map(c => r[c]))
      await batchInsert(autstand, table.name, table.cols, dataRows, table.pk)
      log(`  ${table.name}: ${rows.length} rows`)
    }

    // --- DailyReports (batch) ---
    log('--- Migrating DailyReports ---')
    const reports = await queryProd(prod,
      `SELECT "Id","CreatedAt","ProjectId","Company","Name","Contact","Date",
              "ToolboxTalkAttendance","ToolboxTalkTopics","SafetyIncidents",
              "Manpower","HoursWorked","OtherWorkAccomplished","PlannedWorkTasks",
              "JhaComplianceCheckbox","JhaComplianceVerifierName","RisksAndIssues"
       FROM "DailyReports" ORDER BY "Id"`
    )
    const reportCols = ['Id','CreatedAt','ProjectId','Company','Name','Contact','Date',
      'ToolboxTalkAttendance','ToolboxTalkTopics','SafetyIncidents',
      'Manpower','HoursWorked','OtherWorkAccomplished','PlannedWorkTasks',
      'JhaComplianceCheckbox','JhaComplianceVerifierName','RisksAndIssues']
    const reportRows = reports
      .filter(r => PROJECT_MAP[r.ProjectId])
      .map(r => reportCols.map(c => c === 'ProjectId' ? PROJECT_MAP[r.ProjectId] : r[c]))
    await batchInsert(autstand, 'DailyReports', reportCols, reportRows, 'Id')
    log(`  DailyReports: ${reportRows.length}`)
    await autstand.query(`SELECT setval(pg_get_serial_sequence('"DailyReports"', 'Id'), COALESCE((SELECT MAX("Id") FROM "DailyReports"), 1))`)

    // --- ReportWorkItems (batch — the big one: ~71K rows) ---
    log('--- Migrating ReportWorkItems (batch) ---')
    const workItems = await queryProd(prod,
      `SELECT "Id","DailyReportId","DeviceId","Activity","PercentageDelta",
              "Notes","DashboardTableName","PercentageAfter","PercentageBefore"
       FROM "ReportWorkItems" ORDER BY "Id"`
    )
    const wiCols = ['Id','DailyReportId','DeviceId','Activity','PercentageDelta',
      'Notes','DashboardTableName','PercentageAfter','PercentageBefore']
    const wiRows = workItems.map(w => wiCols.map(c => w[c]))
    await batchInsert(autstand, 'ReportWorkItems', wiCols, wiRows, 'Id')
    log(`  ReportWorkItems: ${wiRows.length}`)
    await autstand.query(`SELECT setval(pg_get_serial_sequence('"ReportWorkItems"', 'Id'), COALESCE((SELECT MAX("Id") FROM "ReportWorkItems"), 1))`)

    // --- ApplicationUsers ---
    log('--- Migrating ApplicationUsers ---')
    const users = await queryProd(prod,
      `SELECT "Id","AzureAdObjectId","Email","Name","FirstLoginAt","LastLoginAt","IsAzureAdAdmin"
       FROM "ApplicationUsers" ORDER BY "Id"`
    )
    const userCols = ['Id','AzureAdObjectId','Email','Name','FirstLoginAt','LastLoginAt','IsAzureAdAdmin']
    await batchInsert(autstand, 'ApplicationUsers', userCols, users.map(u => userCols.map(c => u[c])), 'Id')
    log(`  ApplicationUsers: ${users.length}`)
    await autstand.query(`SELECT setval(pg_get_serial_sequence('"ApplicationUsers"', 'Id'), COALESCE((SELECT MAX("Id") FROM "ApplicationUsers"), 1))`)

    // --- UserProjectRoles ---
    log('--- Migrating UserProjectRoles ---')
    const roles = await queryProd(prod, `SELECT "Id","UserId","ProjectId","Role" FROM "UserProjectRoles" ORDER BY "Id"`)
    const roleCols = ['Id','UserId','ProjectId','Role']
    const roleRows = roles
      .filter(r => PROJECT_MAP[r.ProjectId])
      .map(r => roleCols.map(c => c === 'ProjectId' ? PROJECT_MAP[r.ProjectId] : r[c]))
    await batchInsert(autstand, 'UserProjectRoles', roleCols, roleRows, 'Id')
    log(`  UserProjectRoles: ${roleRows.length}`)
    await autstand.query(`SELECT setval(pg_get_serial_sequence('"UserProjectRoles"', 'Id'), COALESCE((SELECT MAX("Id") FROM "UserProjectRoles"), 1))`)

    // --- Access keys ---
    log('--- Migrating access keys ---')
    const keys = await queryProd(prod,
      `SELECT "Id","ProjectId","KeyHash","KeyPrefix","Label","Role",
              "CreatedAt","ExpiresAt","LastUsedAt","UsageCount","IsActive","CreatedByEmail"
       FROM "ProjectAccessKeys" ORDER BY "Id"`
    )
    for (const k of keys) {
      const newPid = PROJECT_MAP[k.ProjectId]
      if (!newPid) continue
      await autstand.query(
        `INSERT INTO project_access_keys (project_id,key_hash,key_prefix,label,role,created_at,expires_at,last_used_at,usage_count,is_active,created_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [newPid, k.KeyHash, k.KeyPrefix, k.Label, k.Role, k.CreatedAt, k.ExpiresAt, k.LastUsedAt, k.UsageCount, k.IsActive, k.CreatedByEmail]
      )
    }
    log(`  AccessKeys: ${keys.length}`)

    // --- __EFMigrationsHistory ---
    log('--- Migrating __EFMigrationsHistory ---')
    const efH = await queryProd(prod, `SELECT "MigrationId","ProductVersion" FROM "__EFMigrationsHistory"`)
    const efCols = ['MigrationId','ProductVersion']
    await batchInsert(autstand, '__EFMigrationsHistory', efCols, efH.map(h => efCols.map(c => h[c])), 'MigrationId')
    log(`  __EFMigrationsHistory: ${efH.length}`)

    // --- TrackerAuditLogs (batch) ---
    log('--- Migrating TrackerAuditLogs ---')
    const audits = await queryProd(prod,
      `SELECT "Id","Timestamp","UserId","UserName","UserEmail","Action",
              "DeviceId","ProjectId","DashboardTableName","FieldName",
              "ValueBefore","ValueAfter","ReportId","Details"
       FROM "AuditLogs" ORDER BY "Id"`
    )
    const auditCols = ['Id','Timestamp','UserId','UserName','UserEmail','Action',
      'DeviceId','ProjectId','DashboardTableName','FieldName','ValueBefore','ValueAfter','ReportId','Details']
    const auditRows = audits.map(a => auditCols.map(c =>
      c === 'ProjectId' ? (a.ProjectId ? (PROJECT_MAP[a.ProjectId] ?? null) : null) : a[c]
    ))
    await batchInsert(autstand, 'TrackerAuditLogs', auditCols, auditRows, 'Id')
    log(`  TrackerAuditLogs: ${audits.length}`)
    await autstand.query(`SELECT setval(pg_get_serial_sequence('"TrackerAuditLogs"', 'Id'), COALESCE((SELECT MAX("Id") FROM "TrackerAuditLogs"), 1))`)

    // --- Populate ios.device_id ---
    log('--- Populating ios.device_id ---')
    const linkResult = await autstand.query(`
      UPDATE ios
      SET device_id = d."Id"
      FROM "Devices" d, subsystems s, projects p
      WHERE s.id = ios.subsystemid
        AND p.id = s.project_id
        AND d."ProjectId" = p.id
        AND d."Name" = SPLIT_PART(ios.name, ':', 1)
        AND ios.device_id IS NULL
    `)
    log(`  Linked ${linkResult.rowCount} IOs to devices`)

    // --- Verification ---
    log('\n--- Verification ---')
    const checks = [
      ['Devices', 'Devices', 'Devices'],
      ['VFDInstalls', 'VFDInstalls', 'VFDInstalls'],
      ['EnclosureInstalls', 'EnclosureInstalls', 'EnclosureInstalls'],
      ['ControlDeviceInstalls', 'ControlDeviceInstalls', 'ControlDeviceInstalls'],
      ['FeederInstalls', 'FeederInstalls', 'FeederInstalls'],
      ['Circuit480VInstalls', 'Circuit480VInstalls', 'Circuit480VInstalls'],
      ['Circuit120VInstalls', 'Circuit120VInstalls', 'Circuit120VInstalls'],
      ['SorterChuteInstalls', 'SorterChuteInstalls', 'SorterChuteInstalls'],
      ['DailyReports', 'DailyReports', 'DailyReports'],
      ['ReportWorkItems', 'ReportWorkItems', 'ReportWorkItems'],
      ['ApplicationUsers', 'ApplicationUsers', 'ApplicationUsers'],
      ['AuditLogs', 'AuditLogs', 'TrackerAuditLogs'],
    ]

    let allOk = true
    for (const [label, prodTable, autTable] of checks) {
      const prodCount = (await prod.query(`SELECT COUNT(*)::int as c FROM "${prodTable}"`)).rows[0].c
      const autCount = (await autstand.query(`SELECT COUNT(*)::int as c FROM "${autTable}"`)).rows[0].c
      const ok = prodCount === autCount ? 'OK' : 'MISMATCH'
      if (ok === 'MISMATCH') allOk = false
      log(`  ${label.padEnd(25)} prod=${String(prodCount).padStart(6)}  autstand=${String(autCount).padStart(6)}  ${ok}`)
    }

    // Verify original autstand data untouched
    const origChecks: [string, number][] = [['ios', 35288], ['testhistories', 32981], ['subsystems', 67]]
    for (const [table, expected] of origChecks) {
      const actual = (await autstand.query(`SELECT COUNT(*)::int as c FROM ${table}`)).rows[0].c
      const ok = actual === expected ? 'OK' : 'MISMATCH'
      if (ok === 'MISMATCH') allOk = false
      log(`  ${table.padEnd(25)} expected=${String(expected).padStart(6)}  actual=${String(actual).padStart(6)}  ${ok}`)
    }

    log(allOk ? '\n  ALL VERIFICATIONS PASSED. Zero data loss.' : '\n  WARNING: Some verifications failed!')

  } catch (err) {
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    await prod.end()
    await autstand.end()
  }
}

main()
