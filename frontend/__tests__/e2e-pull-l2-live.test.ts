import { describe, it, expect, beforeAll, vi } from 'vitest'

/**
 * LIVE end-to-end test of the FV version-wins pull against a REAL cloud.
 *
 * Unlike pull-l2-nondestructive.test.ts (which mocks the cloud fetch), this runs
 * the REAL pull-l2 POST handler making a REAL HTTP request to a local cloud at
 * http://localhost:13001 (stood up via commissioning-local/local-cloud.compose.yml
 * and seeded with device PS8_22_TPE1 / column "Beacon Flashing" = pass @ version 2).
 *
 * It proves the whole loop: local holds fail@v1, the operator pulls FV, and the
 * strictly-newer cloud value (pass@v2) lands — the exact "Pull doesn't pull the
 * latest FV" bug this work fixes. SKIPS automatically when the local cloud isn't
 * reachable, so it never breaks CI / offline runs.
 */

const CLOUD = 'http://localhost:13001'
const API_KEY = 'e2e-key'
const SID = 40

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE L2Sheets (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, Name TEXT NOT NULL, DisplayName TEXT, DisplayOrder INTEGER NOT NULL, Discipline TEXT, DeviceCount INTEGER DEFAULT 0);
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SheetId INTEGER NOT NULL, Name TEXT NOT NULL, ColumnType TEXT NOT NULL, InputType TEXT, DisplayOrder INTEGER NOT NULL, IsSystem INTEGER DEFAULT 0, IsEditable INTEGER DEFAULT 1, IncludeInProgress INTEGER DEFAULT 0, IsRequired INTEGER DEFAULT 0, Description TEXT, ApplicableMcms TEXT);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SubsystemId INTEGER, SheetId INTEGER NOT NULL, DeviceName TEXT NOT NULL, Mcm TEXT, Subsystem TEXT, DisplayOrder INTEGER NOT NULL, CompletedChecks INTEGER DEFAULT 0, TotalChecks INTEGER DEFAULT 0);
    CREATE TABLE L2CellValues (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudCellId INTEGER, DeviceId INTEGER NOT NULL, ColumnId INTEGER NOT NULL, Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT DEFAULT (datetime('now')), Version INTEGER DEFAULT 0, UNIQUE(DeviceId, ColumnId));
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudDeviceId INTEGER NOT NULL, CloudColumnId INTEGER NOT NULL, Value TEXT, UpdatedBy TEXT, Version INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb, extractDeviceName: () => null }))
vi.mock('@/lib/config', () => ({
  configService: { getConfig: vi.fn(async () => ({ remoteUrl: CLOUD, apiPassword: API_KEY, subsystemId: String(SID) })) },
}))
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: vi.fn() }))
vi.mock('@/lib/db/backup', () => ({ createBackup: vi.fn(async () => ({ filename: 'test-backup.db' })) }))
vi.mock('@/lib/vfd-validation-writer', () => ({ triggerValidationSync: vi.fn(async () => {}) }))
// fetch is REAL here — the whole point is a live HTTP call to the cloud.

import { POST } from '@/app/api/cloud/pull-l2/route'

let cloudUp = false
beforeAll(async () => {
  try {
    const r = await fetch(`${CLOUD}/api/health`, { signal: AbortSignal.timeout(2000) })
    cloudUp = r.ok
  } catch { cloudUp = false }
  if (!cloudUp) console.warn(`[e2e] local cloud ${CLOUD} not reachable — skipping live pull test`)
})

async function runPull() {
  const req: any = { body: { subsystemId: SID } }
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this }, json(o: any) { this.body = o; return this } }
  await POST(req, res)
  return res
}

describe('LIVE e2e: FV version-wins pull against the real cloud', () => {
  it('overwrites a local fail@v1 with the cloud pass@v2 (Beacon Flashing correction lands)', async () => {
    if (!cloudUp) return // skip offline
    // Local mirror of the cloud structure (matched by CloudId), holding the OLD
    // value the tablet last synced — fail @ version 1.
    const sheet = memDb.prepare('INSERT INTO L2Sheets (CloudId,Name,DisplayName,DisplayOrder,Discipline,DeviceCount) VALUES (1,?,?,1,?,1)').run('TPE', 'TPE', 'E').lastInsertRowid as number
    const col = memDb.prepare('INSERT INTO L2Columns (CloudId,SheetId,Name,ColumnType,InputType,DisplayOrder,IncludeInProgress) VALUES (1,?,?,?,?,1,1)').run(sheet, 'Beacon Flashing', 'check', 'pass_fail').lastInsertRowid as number
    const dev = memDb.prepare('INSERT INTO L2Devices (CloudId,SubsystemId,SheetId,DeviceName,Mcm,Subsystem,DisplayOrder,CompletedChecks,TotalChecks) VALUES (1,?,?,?,?,?,1,1,1)').run(SID, sheet, 'PS8_22_TPE1', 'MCM40 Test', 'MCM40 Test').lastInsertRowid as number
    const cell = memDb.prepare('INSERT INTO L2CellValues (CloudCellId,DeviceId,ColumnId,Value,UpdatedBy,UpdatedAt,Version) VALUES (1,?,?,?,?,?,1)').run(dev, col, 'fail', 'field', '2026-07-16T19:45:00.000Z').lastInsertRowid as number

    const res = await runPull()

    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    const after = memDb.prepare('SELECT Value, Version, UpdatedBy FROM L2CellValues WHERE id = ?').get(cell) as any
    expect(after.Value).toBe('pass')          // cloud correction landed
    expect(after.Version).toBe(2)             // local version advanced to the cloud's
    expect(after.UpdatedBy).toBe('emma smucz')// carried the cloud author
  })
})
