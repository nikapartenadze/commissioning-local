/**
 * Remote ops batch (2026-07-12): restart / force-sync / set-config /
 * upload-journals command handling + per-machine quarantine enforcement.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb, spawnSyncMock, kickPush, saveConfig, configState, runJournalUpload } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY, DeadLettered INTEGER DEFAULT 0, RetryCount INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now')), Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE EStopCheckPendingSyncs (id INTEGER PRIMARY KEY, DeadLettered INTEGER DEFAULT 0, RetryCount INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now')), Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE GuidedTaskStatePendingSyncs (id INTEGER PRIMARY KEY, DeadLettered INTEGER DEFAULT 0, RetryCount INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now')), Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE DeviceBlockerPendingSyncs (id INTEGER PRIMARY KEY, DeadLettered INTEGER DEFAULT 0, RetryCount INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now')), Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY, DeadLettered INTEGER DEFAULT 0, RetryCount INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now')), Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
  `)
  const spawnSyncMock = vi.fn(() => ({ status: 0, stdout: 'STATE : 4 RUNNING' }))
  const kickPush = vi.fn()
  const saveConfig = vi.fn(async (_u: any) => {})
  const configState = { mcms: [] as any[], subsystemId: '16' }
  const runJournalUpload = vi.fn(async () => {})
  return { memDb: d, spawnSyncMock, kickPush, saveConfig, configState, runJournalUpload }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
vi.mock('child_process', async (orig) => ({ ...(await orig<any>()), spawnSync: spawnSyncMock }))
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: vi.fn(), getAuditCounts: vi.fn(() => ({})) }))

vi.mock('@/lib/cloud/auto-sync', () => ({ getAutoSyncService: () => ({ kickPush }) }))

vi.mock('@/lib/config', () => ({
  configService: {
    getMcms: vi.fn(async () => configState.mcms),
    getConfig: vi.fn(async () => ({ subsystemId: configState.subsystemId })),
    saveConfig,
  },
}))

vi.mock('@/lib/cloud/journal-uploader', () => ({ runJournalUpload }))

import { executeCommand } from '@/lib/heartbeat/command-handler'
import { evaluateVersionLock, isVersionLockExempt } from '@/lib/update/version-lock'

beforeEach(() => {
  memDb.exec('DELETE FROM L2PendingSyncs; DELETE FROM EStopCheckPendingSyncs; DELETE FROM GuidedTaskStatePendingSyncs; DELETE FROM DeviceBlockerPendingSyncs; DELETE FROM PendingSyncs;')
  configState.mcms = []
  configState.subsystemId = '16'
  vi.clearAllMocks()
})

describe('force-sync command', () => {
  it('unparks the four non-IO queues (never IO) and kicks a push', async () => {
    memDb.exec(`
      INSERT INTO L2PendingSyncs (DeadLettered, RetryCount) VALUES (1, 10), (0, 0);
      INSERT INTO EStopCheckPendingSyncs (DeadLettered, RetryCount) VALUES (1, 10);
      INSERT INTO PendingSyncs (DeadLettered, RetryCount) VALUES (1, 10);
    `)
    const r = await executeCommand({ id: 1, type: 'force-sync', payload: null })
    expect(r.status).toBe('done')
    expect(r.result).toContain('unparked 2')
    expect(memDb.prepare('SELECT COUNT(*) c FROM L2PendingSyncs WHERE DeadLettered=1').get()).toMatchObject({ c: 0 })
    // IO parks intentionally untouched (push-force is operator-gated).
    expect(memDb.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE DeadLettered=1').get()).toMatchObject({ c: 1 })
    expect(kickPush).toHaveBeenCalled()
  })
})

describe('set-config command', () => {
  it('reassigns a single-MCM tablet and audits it', async () => {
    const r = await executeCommand({ id: 2, type: 'set-config', payload: { subsystemId: 41 } })
    expect(r.status).toBe('done')
    expect(saveConfig).toHaveBeenCalledWith({ subsystemId: '41' })
  })

  it('REFUSES on a central/multi-MCM box', async () => {
    configState.mcms = [{ subsystemId: '37' }, { subsystemId: '38' }]
    const r = await executeCommand({ id: 3, type: 'set-config', payload: { subsystemId: 41 } })
    expect(r.status).toBe('failed')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('rejects a missing/invalid subsystemId', async () => {
    const r = await executeCommand({ id: 4, type: 'set-config', payload: {} })
    expect(r.status).toBe('failed')
  })
})

describe('restart command', () => {
  it('refuses when not running as the service (portable)', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '' } as any)
    const r = await executeCommand({ id: 5, type: 'restart', payload: null })
    expect(r.status).toBe('failed')
    expect(r.result).toContain('portable')
  })

  it('acks with a delayed exit under the service', async () => {
    vi.useFakeTimers()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const r = await executeCommand({ id: 6, type: 'restart', payload: null })
    expect(r.status).toBe(process.platform === 'win32' ? 'done' : 'failed')
    if (process.platform === 'win32') {
      expect(exitSpy).not.toHaveBeenCalled() // ack ships before the exit
      vi.advanceTimersByTime(26_000)
      expect(exitSpy).toHaveBeenCalledWith(0)
    }
    exitSpy.mockRestore()
    vi.useRealTimers()
  })
})

describe('upload-journals command', () => {
  it('runs the journal uploader on demand', async () => {
    const r = await executeCommand({ id: 7, type: 'upload-journals', payload: null })
    expect(r.status).toBe('done')
    expect(runJournalUpload).toHaveBeenCalled()
  })
})

describe('quarantine lock evaluation', () => {
  it('quarantined locks REGARDLESS of version; release unlocks', () => {
    const locked = evaluateVersionLock('9.9.9', { minVersion: null, lockMessage: null, fetchedAt: '', quarantined: true, quarantineMessage: 'paused' }, 'live')
    expect(locked.locked).toBe(true)
    expect(locked.quarantined).toBe(true)
    expect(locked.quarantineMessage).toBe('paused')

    const released = evaluateVersionLock('9.9.9', { minVersion: null, lockMessage: null, fetchedAt: '', quarantined: false }, 'live')
    expect(released.locked).toBe(false)
  })

  it('the guard allowlist still lets update/status/auth through while quarantined', () => {
    expect(isVersionLockExempt('GET', '/api/update/status')).toBe(true)
    expect(isVersionLockExempt('POST', '/api/auth/login')).toBe(true)
    expect(isVersionLockExempt('POST', '/api/l2/cell')).toBe(false)
  })
})
