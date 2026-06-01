/**
 * Test: the recovery audit log appends durable JSONL, never throws, and prunes
 * files past the retention window — the "recover data" guarantee.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reclog-'))
const logDir = path.join(tmp, 'logs')
const today = new Date().toISOString().slice(0, 10)

// Logs resolve beside the DB; point DATABASE_URL at the temp dir BEFORE import.
process.env.DATABASE_URL = 'file:' + path.join(tmp, 'database.db')
process.env.RECOVERY_LOG_RETENTION_DAYS = '14'

let mod: typeof import('@/lib/logging/recovery-log')

beforeAll(async () => {
  mod = await import('@/lib/logging/recovery-log')
})
afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('recovery-log', () => {
  it('appends a JSONL line for an event', () => {
    mod.auditLog({ type: 'io.test', subsystemId: '39', ioId: 123, user: 'Tester', result: 'Passed', version: 4 })
    const f = path.join(logDir, `audit-${today}.jsonl`)
    expect(fs.existsSync(f)).toBe(true)
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1])
    expect(last.type).toBe('io.test')
    expect(last.ioId).toBe(123)
    expect(last.result).toBe('Passed')
    expect(last.version).toBe(4)
    expect(typeof last.ts).toBe('string')
  })

  it('records a sync.push.drop with the full payload for recovery', () => {
    mod.auditLog({
      type: 'sync.push.drop', ioId: 999, version: 2, result: 'Failed',
      user: 'Bob', reason: 'retry-cap', detail: { pendingId: 5, comments: 'x' },
    })
    const f = path.join(logDir, `audit-${today}.jsonl`)
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const drop = lines.find((l) => l.type === 'sync.push.drop' && l.ioId === 999)
    expect(drop).toBeTruthy()
    expect(drop.reason).toBe('retry-cap')
    expect(drop.detail.pendingId).toBe(5)
  })

  it('never throws on malformed input', () => {
    const circular: any = {}
    circular.self = circular
    expect(() => mod.auditLog({ type: 'io.test', detail: circular })).not.toThrow()
  })

  it('reports the configured retention window', () => {
    expect(mod.getRecoveryRetentionDays()).toBe(14)
  })

  it('prunes audit files older than the retention window', async () => {
    const oldDay = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const oldFile = path.join(logDir, `audit-${oldDay}.jsonl`)
    fs.writeFileSync(oldFile, '{"old":true}\n')
    expect(fs.existsSync(oldFile)).toBe(true)

    // Prune runs once per day (module-cached). Re-import to reset that guard,
    // then a fresh write triggers the prune sweep.
    vi.resetModules()
    const fresh = await import('@/lib/logging/recovery-log')
    fresh.auditLog({ type: 'server.start' })

    expect(fs.existsSync(oldFile)).toBe(false) // pruned
    expect(fs.existsSync(path.join(logDir, `audit-${today}.jsonl`))).toBe(true) // kept
  })
})
