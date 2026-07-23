/**
 * RETRY-REAL + COMPARE-TIMEOUT proof.
 *
 * Two honesty fixes are proven here:
 *
 *  1. Sync Center "Retry" used to only reset the local queue-row flags and toast
 *     "Re-queued for sync" — implying a send that only the 10s background loop
 *     actually performs. On a dead link nothing new happened, so "Retry sends it
 *     now" was a lie. The actions route now kicks ONE real drain (the cloud
 *     force-sync entrypoint, AutoSyncService.kickPush) and reports the TRUE
 *     outcome. We prove: 'sent' when the row lands, 'still_failing' + httpStatus
 *     when the cloud 403s, 'no_connection' when offline, and that it never hangs
 *     when the drain can't conclude (bounded timeout → 'still_trying').
 *
 *  2. The cloud Compare tab fetched with NO timeout, so a dead connection spun
 *     the spinner forever. `fetchWithTimeout` bounds it and aborts.
 *
 * Harness mirrors sync-queue-resolution.test.ts: the @/lib/db-sqlite singleton is
 * a throwaway in-memory better-sqlite3 DB with the IO queue + label tables;
 * queue-inspector/retry-push run REAL against it, and the auto-sync drain is
 * mocked so kickPush() deterministically simulates delivery / 403 / offline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { memDb, kickPush, getSvc } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, Description TEXT, Result TEXT, SubsystemId INTEGER, CloudRemoved INTEGER DEFAULT 0);
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, TestResult TEXT,
      RetryCount INTEGER DEFAULT 0, LastError TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
  `)
  const kickPush = vi.fn()
  const getSvc = vi.fn(() => ({ kickPush }))
  return { memDb: d, kickPush, getSvc }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
vi.mock('@/lib/cloud/auto-sync', () => ({ getAutoSyncService: getSvc }))
// Only exercised by the discard path — keep the retry test hermetic (no fs).
vi.mock('@/lib/db/backup', () => ({ createBackup: vi.fn(async () => ({ filename: 'noop.db' })) }))
vi.mock('@/lib/sync/discard-log', () => ({ writeDiscardLog: vi.fn(() => null) }))

import { POST } from '@/app/api/sync/queue/actions/route'
import { deriveRetryResult, parseHttpStatus, performRetryPush } from '@/lib/sync/retry-push'
import { fetchWithTimeout, FetchTimeoutError, isFetchTimeoutError } from '@/lib/fetch-with-timeout'
import type { QueueItem, QueueKind } from '@/lib/sync/queue-inspector'

const IO_ID = 1

function seedParkedIo(lastError = 'timeout'): number {
  memDb.prepare("INSERT OR IGNORE INTO Subsystems (id, Name) VALUES (47, 'MCM11')").run()
  memDb.prepare("INSERT OR IGNORE INTO Ios (id, Name, Description, Result, SubsystemId) VALUES (?, 'DI_START_PB', 'Start PB', 'Passed', 47)").run(IO_ID)
  const info = memDb.prepare('INSERT INTO PendingSyncs (IoId, TestResult, RetryCount, LastError, DeadLettered) VALUES (?, ?, 3, ?, 1)').run(IO_ID, 'Passed', lastError)
  return Number(info.lastInsertRowid)
}

function makeRes(): any {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this },
    json(payload: any) { this.body = payload; return this },
  }
}

async function callRetry(id: number): Promise<any> {
  const req: any = { body: { action: 'retry', ids: [{ kind: 'io', id }] } }
  const res = makeRes()
  await POST(req, res)
  return res
}

beforeEach(() => {
  memDb.exec('DELETE FROM PendingSyncs; DELETE FROM Ios; DELETE FROM Subsystems;')
  kickPush.mockReset()
  getSvc.mockReset()
  getSvc.mockImplementation(() => ({ kickPush }))
  delete process.env.SYNC_RETRY_PUSH_BUDGET_MS
  delete process.env.SYNC_RETRY_PUSH_POLL_MS
})

// ─────────────────────────────────────────────────────────────────────────
// The actions route — retry now attempts a REAL push and reports honestly.
// ─────────────────────────────────────────────────────────────────────────
describe('actions route — retry-real outcome', () => {
  it("returns 'sent' when the drain delivers the row (row deleted from the queue)", async () => {
    const id = seedParkedIo()
    // Simulate the background drain delivering the row: it deletes it on success.
    kickPush.mockImplementation(() => { memDb.prepare('DELETE FROM PendingSyncs WHERE id = ?').run(id) })

    const res = await callRetry(id)

    expect(kickPush).toHaveBeenCalledTimes(1)      // a REAL push was actually kicked
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ success: true, action: 'retry', affected: 1, pushed: 1, failed: 0, outcome: 'sent' })
    expect(res.body.httpStatus).toBeUndefined()
    expect(res.body.message).toContain('Sent 1')
  })

  it("returns 'still_failing' WITH httpStatus 403 when the cloud rejects with a key mismatch", async () => {
    const id = seedParkedIo()
    // A 403 is network-classified (no strike): the drain keeps the row and writes
    // LastError='HTTP 403' (see cloud-sync-service + auto-sync).
    kickPush.mockImplementation(() => { memDb.prepare("UPDATE PendingSyncs SET LastError = 'HTTP 403', DeadLettered = 0 WHERE id = ?").run(id) })

    const res = await callRetry(id)

    expect(res.body).toMatchObject({ success: true, affected: 1, pushed: 0, failed: 1, outcome: 'still_failing', httpStatus: 403 })
    expect(res.body.message).toContain('403')
    expect(res.body.message.toLowerCase()).toContain('key mismatch')
  })

  it("returns 'no_connection' when the drain fails offline (no HTTP status)", async () => {
    const id = seedParkedIo()
    kickPush.mockImplementation(() => { memDb.prepare("UPDATE PendingSyncs SET LastError = 'offline', DeadLettered = 0 WHERE id = ?").run(id) })

    const res = await callRetry(id)

    expect(res.body).toMatchObject({ success: true, outcome: 'no_connection', pushed: 0, failed: 1 })
    expect(res.body.httpStatus).toBeUndefined()
    expect(res.body.message.toLowerCase()).toContain('will keep trying')
  })

  it("does NOT hang when the drain can't conclude — bounded timeout returns 'still_trying'", async () => {
    const id = seedParkedIo()
    // Drain kicked but never adjudicates the row (stays un-parked, LastError null).
    kickPush.mockImplementation(() => { /* no-op: nothing settles */ })
    // Tiny budget so the bounded poll returns fast instead of waiting 20s.
    process.env.SYNC_RETRY_PUSH_BUDGET_MS = '40'
    process.env.SYNC_RETRY_PUSH_POLL_MS = '5'

    const started = Date.now()
    const res = await callRetry(id)
    const elapsed = Date.now() - started

    expect(kickPush).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(2000)            // proves it did not hang
    expect(res.body).toMatchObject({ success: true, outcome: 'still_trying' })
    expect(res.body.message.toLowerCase()).toContain('still')
  })

  it("does not hang when the sync service isn't running (no drain to kick)", async () => {
    const id = seedParkedIo()
    getSvc.mockReturnValueOnce(null as any) // getAutoSyncService() === null (real return is AutoSyncService | null)
    process.env.SYNC_RETRY_PUSH_BUDGET_MS = '40'

    const res = await callRetry(id)

    expect(kickPush).not.toHaveBeenCalled()
    expect(res.body).toMatchObject({ success: true, outcome: 'still_trying' })
  })

  it('still resets the parked flags via retry() before pushing (data-safety: value untouched)', async () => {
    const id = seedParkedIo('some weird error')
    kickPush.mockImplementation(() => { /* leave row as-is */ })
    process.env.SYNC_RETRY_PUSH_BUDGET_MS = '20'

    await callRetry(id)

    const row = memDb.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(id) as any
    expect(row.DeadLettered).toBe(0)   // un-parked
    expect(row.RetryCount).toBe(0)     // strikes cleared
    expect(row.TestResult).toBe('Passed') // the QUEUED VALUE is never touched
  })
})

// ─────────────────────────────────────────────────────────────────────────
// deriveRetryResult — pure outcome mapping (no I/O).
// ─────────────────────────────────────────────────────────────────────────
const mkItem = (kind: QueueKind, id: number, lastError: string | null): QueueItem =>
  ({ kind, id, lastError } as unknown as QueueItem)
const ref = (kind: QueueKind, id: number) => ({ kind, id })

describe('deriveRetryResult — pure outcome mapping', () => {
  it('all rows gone and none resolved → sent', () => {
    const r = deriveRetryResult([ref('io', 1), ref('io', 2)], [], new Set())
    expect(r).toMatchObject({ outcome: 'sent', pushed: 2, failed: 0 })
    expect(r.message).toContain('Sent 2')
  })

  it('present with HTTP 403 → still_failing + httpStatus 403', () => {
    const r = deriveRetryResult([ref('io', 1)], [mkItem('io', 1, 'HTTP 403')], new Set())
    expect(r).toMatchObject({ outcome: 'still_failing', httpStatus: 403, pushed: 0, failed: 1 })
  })

  it('present with a humanised HTTP 404 removal reason → still_failing + httpStatus 404', () => {
    const r = deriveRetryResult([ref('io', 1)], [mkItem('io', 1, 'HTTP 404 — target no longer exists on cloud (removed)')], new Set())
    expect(r).toMatchObject({ outcome: 'still_failing', httpStatus: 404 })
  })

  it('present with offline reason → no_connection, no httpStatus', () => {
    const r = deriveRetryResult([ref('io', 1)], [mkItem('io', 1, 'fetch failed')], new Set())
    expect(r).toMatchObject({ outcome: 'no_connection', failed: 1 })
    expect(r.httpStatus).toBeUndefined()
  })

  it('present with HTTP 500 → no_connection + httpStatus 500 (reachable but erroring)', () => {
    const r = deriveRetryResult([ref('io', 1)], [mkItem('io', 1, 'HTTP 500 (network-level, no strike)')], new Set())
    expect(r).toMatchObject({ outcome: 'no_connection', httpStatus: 500 })
  })

  it('absent BUT resolved (removed on cloud) → still_failing, NOT counted as sent', () => {
    const r = deriveRetryResult([ref('io', 1)], [], new Set(['io:1']))
    expect(r).toMatchObject({ outcome: 'still_failing', pushed: 0, failed: 1 })
    expect(r.message.toLowerCase()).toContain('removed on the cloud')
  })

  it('present with NULL LastError (not yet adjudicated) → still_trying', () => {
    const r = deriveRetryResult([ref('io', 1)], [mkItem('io', 1, null)], new Set())
    expect(r).toMatchObject({ outcome: 'still_trying', pushed: 0 })
  })

  it('a client 403 wins over an unattended row (surface the actionable failure)', () => {
    const r = deriveRetryResult([ref('io', 1), ref('io', 2)], [mkItem('io', 1, 'HTTP 403'), mkItem('io', 2, null)], new Set())
    expect(r).toMatchObject({ outcome: 'still_failing', httpStatus: 403 })
  })
})

describe('parseHttpStatus', () => {
  it('extracts the status from HTTP-prefixed LastError variants', () => {
    expect(parseHttpStatus('HTTP 403')).toBe(403)
    expect(parseHttpStatus('HTTP 404 — target no longer exists')).toBe(404)
    expect(parseHttpStatus('HTTP 500 (network-level, no strike)')).toBe(500)
  })
  it('returns undefined for non-HTTP reasons', () => {
    expect(parseHttpStatus('offline')).toBeUndefined()
    expect(parseHttpStatus('fetch failed')).toBeUndefined()
    expect(parseHttpStatus(null)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// performRetryPush — no candidates short-circuit.
// ─────────────────────────────────────────────────────────────────────────
describe('performRetryPush edge cases', () => {
  it('short-circuits to still_trying when the selected rows are no longer queued', async () => {
    // No rows seeded → snapshotRefs finds nothing.
    const r = await performRetryPush([{ kind: 'io', id: 999 }])
    expect(r.outcome).toBe('still_trying')
    expect(r.pushed).toBe(0)
    expect(kickPush).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// fetchWithTimeout — the Compare tab's spin-forever fix.
// ─────────────────────────────────────────────────────────────────────────
describe('fetchWithTimeout — bounds a fetch and aborts on timeout', () => {
  it('aborts and throws FetchTimeoutError when the request outlasts the deadline', async () => {
    let abortedSignal: AbortSignal | null = null
    // Mirror fetch: never resolve on its own, reject when the signal aborts.
    const run = (signal: AbortSignal) => new Promise<Response>((_, reject) => {
      abortedSignal = signal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })

    await expect(fetchWithTimeout(run, 20)).rejects.toBeInstanceOf(FetchTimeoutError)
    expect(abortedSignal).not.toBeNull()
    expect(abortedSignal!.aborted).toBe(true)   // the request was actually aborted, not abandoned
  })

  it('returns the Response when it arrives before the deadline', async () => {
    const ok = { ok: true, status: 200 } as Response
    const r = await fetchWithTimeout(async () => ok, 1000)
    expect(r).toBe(ok)
  })

  it('re-throws a non-timeout error unchanged (not misreported as a timeout)', async () => {
    const boom = new Error('DNS boom')
    await expect(fetchWithTimeout(async () => { throw boom }, 1000)).rejects.toBe(boom)
  })

  it('isFetchTimeoutError distinguishes the timeout from other errors', () => {
    expect(isFetchTimeoutError(new FetchTimeoutError(15000))).toBe(true)
    expect(isFetchTimeoutError(new Error('nope'))).toBe(false)
    expect(isFetchTimeoutError(new DOMException('aborted', 'AbortError'))).toBe(false)
  })
})

afterEach(() => {
  delete process.env.SYNC_RETRY_PUSH_BUDGET_MS
  delete process.env.SYNC_RETRY_PUSH_POLL_MS
})
