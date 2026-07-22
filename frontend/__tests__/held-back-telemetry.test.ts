/**
 * HELD-BACK TELEMETRY (2026-07-22, spec Part 2).
 *
 * The cloud used to receive only COUNTS, so it could say THAT a tablet had
 * stuck work but never WHICH row or WHY — LastError never left the tablet. And
 * `pendingSyncCount` is a whole-database number, so the cloud had to infer a
 * row's project from `tool_instances.current_project_id`, which is wrong for
 * every row queued before an operator switched projects.
 *
 * These tests pin the properties that make the new `heldBack` array trustworthy:
 *
 *   1. The CAP IS A DISPLAY BOUND, NOT A TRUTH BOUND. A truncated list must be
 *      impossible to mistake for the full set: the true total and the per-project
 *      rollup are always computed over every held-back row.
 *   2. PROJECT ATTRIBUTION IS EXACT OR ABSENT. A row is attributed only when it
 *      demonstrably belongs to the current API-key→project binding. It is never
 *      attributed by assumption — including across a re-key.
 *   3. NO RAW `LastError` LEAVES THE TABLET. The emitted reason is the canonical
 *      per-classification text, never the cloud's verbatim string.
 *   4. TELEMETRY NEVER BREAKS SYNCING. If naming the rows fails, the counts
 *      still ship.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  // Faithful mirror of the production queue schema (lib/db-sqlite.ts).
  d.exec(`
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, Description TEXT, Result TEXT,
      SubsystemId INTEGER, CloudRemoved INTEGER DEFAULT 0);
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, DeviceName TEXT, Mcm TEXT, SubsystemId INTEGER);
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, Name TEXT);

    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, TestResult TEXT,
      RetryCount INTEGER DEFAULT 0, LastError TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0,
      Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT,
      ReAdjudicatedAt TEXT);
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudDeviceId INTEGER,
      CloudColumnId INTEGER, Value TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0,
      Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE DeviceBlockerPendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      DeviceName TEXT, Op TEXT, BlockerResponsibleParty TEXT, BlockerDescription TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0,
      Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE EStopCheckPendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      ZoneName TEXT, CheckTag TEXT, Result TEXT, CheckType TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0,
      ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE GuidedTaskStatePendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      TaskId TEXT, Status TEXT, Reason TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0,
      ResolvedAt TEXT, ResolvedReason TEXT);

    CREATE TABLE SyncMaintenanceFlags (Key TEXT PRIMARY KEY, Value TEXT, UpdatedAt TEXT);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: () => {} }))

import { collectQueueStats, HELD_BACK_LIMIT } from '@/lib/heartbeat/queue-stats'
import { REASONS } from '@/lib/sync/queue-inspector'
import { noteCloudProjectId, getCloudProjectBinding, attributeProjectId } from '@/lib/sync/cloud-project'

/** A cloud rejection carrying text we must never forward off-box. */
const REJECTED_ERROR =
  'cloud-rejected: value invalid for https://commissioning.autstand.com/api/sync/update'

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

/** Insert a PARKED (held-back) IO row: DeadLettered, not orphaned, not resolved. */
function parkedIo(opts: { id: number; name: string; createdAt: string; lastError?: string }) {
  memDb.prepare('INSERT OR REPLACE INTO Ios (id, Name, SubsystemId) VALUES (?, ?, 7)').run(opts.id, opts.name)
  memDb
    .prepare(
      `INSERT INTO PendingSyncs (IoId, TestResult, CreatedAt, DeadLettered, Orphaned, Resolved, LastError)
       VALUES (?, 'PASS', ?, 1, 0, 0, ?)`,
    )
    .run(opts.id, opts.createdAt, opts.lastError ?? REJECTED_ERROR)
}

beforeEach(() => {
  for (const t of [
    'PendingSyncs',
    'L2PendingSyncs',
    'DeviceBlockerPendingSyncs',
    'EStopCheckPendingSyncs',
    'GuidedTaskStatePendingSyncs',
    'Ios',
    'Subsystems',
    'SyncMaintenanceFlags',
  ]) {
    memDb.prepare(`DELETE FROM ${t}`).run()
  }
  memDb.prepare("INSERT INTO Subsystems (id, Name) VALUES (7, 'MCM07')").run()
})

describe('heldBack — the cap is a display bound, not a truth bound', () => {
  it('reports the TRUE total while listing at most HELD_BACK_LIMIT rows', () => {
    // Far more held-back rows than the list can carry.
    const total = HELD_BACK_LIMIT * 8
    for (let i = 1; i <= total; i++) {
      parkedIo({ id: i, name: `IO_${i}`, createdAt: iso(i) })
    }

    const stats = collectQueueStats()

    // The list is capped …
    expect(stats.heldBack).toHaveLength(HELD_BACK_LIMIT)
    // … but the COUNT is complete. This is the whole point: the cloud must be
    // able to say "200 held back" while showing 25.
    expect(stats.heldBackTotal).toBe(total)
    expect(stats.heldBackTruncated).toBe(true)
  })

  it('does not flag truncation when every held-back row fits in the list', () => {
    parkedIo({ id: 1, name: 'IO_ONLY', createdAt: iso(5) })
    const stats = collectQueueStats()
    expect(stats.heldBack).toHaveLength(1)
    expect(stats.heldBackTotal).toBe(1)
    expect(stats.heldBackTruncated).toBe(false)
  })

  it('names the OLDEST rows first, so the shown 25 are the longest stuck', () => {
    for (let i = 1; i <= HELD_BACK_LIMIT + 5; i++) {
      // Higher i == older.
      parkedIo({ id: i, name: `IO_${i}`, createdAt: iso(i * 10) })
    }
    const ages = collectQueueStats().heldBack!.map((h) => h.ageMin!)
    expect(ages).toEqual([...ages].sort((a, b) => b - a))
    // The very oldest row must be present.
    expect(ages[0]).toBe((HELD_BACK_LIMIT + 5) * 10)
  })

  it('per-project rollup counts EVERY held-back row, not just the listed ones', () => {
    noteCloudProjectId(42)
    const total = HELD_BACK_LIMIT * 4
    for (let i = 1; i <= total; i++) {
      parkedIo({ id: i, name: `IO_${i}`, createdAt: iso(0) }) // all inside the binding
    }
    const stats = collectQueueStats()
    expect(stats.heldBack!.length).toBe(HELD_BACK_LIMIT)
    // Rollup is over the full set — summing it must reproduce the true total.
    const summed = Object.values(stats.heldBackByProject!).reduce((a, b) => a + b, 0)
    expect(summed).toBe(total)
    expect(stats.heldBackByProject!['42']).toBe(total)
  })

  it('omits heldBack entirely on a healthy tablet, keeping the payload unchanged', () => {
    const stats = collectQueueStats()
    expect(stats.heldBack).toBeUndefined()
    expect(stats.heldBackByProject).toBeUndefined()
    expect(stats.heldBackTotal).toBe(0)
    expect(stats.heldBackTruncated).toBe(false)
  })
})

describe('heldBack — project attribution is exact or absent', () => {
  it('attributes rows created after the binding to the banked cloud project', () => {
    noteCloudProjectId(42)
    parkedIo({ id: 1, name: 'IO_NEW', createdAt: iso(0) })
    expect(collectQueueStats().heldBack![0].projectId).toBe(42)
  })

  it('reports null — never a guess — when no project has ever been observed', () => {
    parkedIo({ id: 1, name: 'IO_UNKNOWN', createdAt: iso(1) })
    const stats = collectQueueStats()
    expect(stats.heldBack![0].projectId).toBeNull()
    expect(stats.heldBackByProject!.unattributed).toBe(1)
  })

  it('does NOT relabel rows that predate the current binding', () => {
    // A row queued long before this tablet was pointed at project 42.
    parkedIo({ id: 1, name: 'IO_OLD', createdAt: iso(600) })
    noteCloudProjectId(42)
    parkedIo({ id: 2, name: 'IO_NEW', createdAt: iso(0) })

    const stats = collectQueueStats()
    const byName = Object.fromEntries(stats.heldBack!.map((h) => [h.ioName, h.projectId]))
    expect(byName.IO_NEW).toBe(42)
    // The pre-binding row is unknown, NOT project 42. Under-claiming is
    // recoverable; mis-attribution is exactly the bug this replaces.
    expect(byName.IO_OLD).toBeNull()
  })

  it('restarts the attributable window when the tablet is re-keyed to another project', () => {
    noteCloudProjectId(42)
    const firstBoundAt = getCloudProjectBinding().boundAt
    expect(getCloudProjectBinding().projectId).toBe(42)

    // Re-observing the SAME id must not move the window.
    noteCloudProjectId(42)
    expect(getCloudProjectBinding().boundAt).toBe(firstBoundAt)

    // A different project means a re-key: rows from the old binding must fall
    // out of attribution rather than silently becoming project 99's.
    const oldRow = iso(600)
    noteCloudProjectId(99)
    const binding = getCloudProjectBinding()
    expect(binding.projectId).toBe(99)
    expect(attributeProjectId(oldRow, binding)).toBeNull()
  })

  it('never attributes a row whose timestamp cannot be read', () => {
    noteCloudProjectId(42)
    const binding = getCloudProjectBinding()
    expect(attributeProjectId(null, binding)).toBeNull()
    expect(attributeProjectId('not-a-date', binding)).toBeNull()
  })

  it('ignores a malformed project id instead of banking nonsense', () => {
    for (const bad of [undefined, null, 0, -3, 'abc', 1.5, {}]) {
      noteCloudProjectId(bad)
    }
    expect(getCloudProjectBinding().projectId).toBeNull()
  })

  it('attributes the SQLite datetime() timestamp shape as well as ISO', () => {
    noteCloudProjectId(42)
    const binding = getCloudProjectBinding()
    // 'YYYY-MM-DD HH:MM:SS' (UTC, no zone marker) — the other stored shape.
    const soon = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19)
    expect(attributeProjectId(soon, binding)).toBe(42)
  })
})

describe('heldBack — no raw cloud text leaves the tablet', () => {
  it('emits the canonical classification reason, never the verbatim LastError', () => {
    parkedIo({ id: 1, name: 'IO_REJ', createdAt: iso(3), lastError: REJECTED_ERROR })
    const item = collectQueueStats().heldBack![0]

    expect(item.classification).toBe('cloud_rejected')
    // The exact operator-facing text for this classification …
    expect(item.reason).toBe(REASONS.cloud_rejected)
    // … and NOT the interpolated "(Cloud said: …)" variant, which would forward
    // arbitrary cloud-authored text (here, an internal URL) off the tablet.
    expect(item.reason).not.toContain('Cloud said')
    expect(JSON.stringify(item)).not.toContain('commissioning.autstand.com')
  })

  it('reuses the existing classification vocabulary verbatim', () => {
    parkedIo({ id: 1, name: 'IO_GONE', createdAt: iso(2), lastError: 'HTTP 404 not found' })
    parkedIo({ id: 2, name: 'IO_CONFLICT', createdAt: iso(2), lastError: 'version conflict 409' })
    const byName = Object.fromEntries(
      collectQueueStats().heldBack!.map((h) => [h.ioName, h]),
    )
    expect(byName.IO_GONE.classification).toBe('gone_on_cloud')
    expect(byName.IO_GONE.reason).toBe(REASONS.gone_on_cloud)
    expect(byName.IO_CONFLICT.classification).toBe('version_conflict')
    expect(byName.IO_CONFLICT.reason).toBe(REASONS.version_conflict)
  })
})

describe('heldBack — only rows that truly need a human', () => {
  it('excludes active, orphaned and resolved rows', () => {
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId) VALUES (1, ?, 7)').run('IO_ACTIVE')
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId) VALUES (2, ?, 7)').run('IO_ORPHAN')
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId) VALUES (3, ?, 7)').run('IO_RESOLVED')
    // Active: still draining, nobody owes it anything yet.
    memDb.prepare(
      `INSERT INTO PendingSyncs (IoId, CreatedAt, DeadLettered, Orphaned, Resolved) VALUES (1, ?, 0, 0, 0)`,
    ).run(iso(1))
    // Orphaned: self-heals if the target reappears.
    memDb.prepare(
      `INSERT INTO PendingSyncs (IoId, CreatedAt, DeadLettered, Orphaned, Resolved) VALUES (2, ?, 1, 1, 0)`,
    ).run(iso(1))
    // Resolved: terminal.
    memDb.prepare(
      `INSERT INTO PendingSyncs (IoId, CreatedAt, DeadLettered, Orphaned, Resolved) VALUES (3, ?, 1, 1, 1)`,
    ).run(iso(1))
    // The only genuine held-back row.
    parkedIo({ id: 4, name: 'IO_HELD', createdAt: iso(1) })

    const stats = collectQueueStats()
    expect(stats.heldBack!.map((h) => h.ioName)).toEqual(['IO_HELD'])
    expect(stats.heldBackTotal).toBe(1)
    // The orphaned row IS parked (DeadLettered, unresolved), so `parked` counts
    // it — but it self-heals, so held-back must NOT. Held back is a strict
    // subset of parked; conflating them raises an alarm nobody has to act on.
    expect(stats.parked).toBe(2)
    expect(stats.heldBackTotal).toBeLessThan(stats.parked)
  })

  it('covers all five queues and only sets ioId for the IO queue', () => {
    parkedIo({ id: 1, name: 'IO_HELD', createdAt: iso(5) })
    memDb.prepare(
      `INSERT INTO DeviceBlockerPendingSyncs (SubsystemId, DeviceName, Op, CreatedAt, DeadLettered, Orphaned, Resolved, LastError)
       VALUES (7, 'VFD-1', 'set', ?, 1, 0, 0, 'rejected')`,
    ).run(iso(4))
    memDb.prepare(
      `INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CreatedAt, DeadLettered, Resolved, LastError)
       VALUES (7, 'ZONE-A', ?, 1, 0, 'rejected')`,
    ).run(iso(3))
    memDb.prepare(
      `INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status, CreatedAt, DeadLettered, Resolved, LastError)
       VALUES (7, 'task-9', 'skipped', ?, 1, 0, 'rejected')`,
    ).run(iso(2))

    const stats = collectQueueStats()
    expect(stats.heldBackTotal).toBe(4)
    const byQueue = Object.fromEntries(stats.heldBack!.map((h) => [h.queue, h]))
    expect(Object.keys(byQueue).sort()).toEqual(['blocker', 'estop', 'guided', 'io'])
    // ioId is a real Ios id only for the io queue; the others key on
    // device/zone/task and must not present a queue-row id as an IO id.
    expect(byQueue.io.ioId).toBe(1)
    expect(byQueue.blocker.ioId).toBeNull()
    expect(byQueue.estop.ioId).toBeNull()
    expect(byQueue.guided.ioId).toBeNull()
    // Every row still carries its owning MCM.
    for (const h of stats.heldBack!) expect(h.subsystemId).toBe(7)
  })
})

describe('heldBack — telemetry must never break syncing', () => {
  it('still reports the counts when naming the rows fails', async () => {
    parkedIo({ id: 1, name: 'IO_HELD', createdAt: iso(5) })

    const inspector = await import('@/lib/sync/queue-inspector')
    const spy = vi.spyOn(inspector, 'listQueue').mockImplementation(() => {
      throw new Error('inspector exploded')
    })
    try {
      const stats = collectQueueStats()
      // The aggregate counts are untouched — they come from a plain COUNT that
      // cannot fail with the enrichment.
      expect(stats.parked).toBe(1)
      expect(stats.heldBackTotal).toBe(1)
      // Only the names are lost.
      expect(stats.heldBack).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('never throws out of collectQueueStats when the flag table is missing', () => {
    parkedIo({ id: 1, name: 'IO_HELD', createdAt: iso(5) })
    memDb.exec('DROP TABLE SyncMaintenanceFlags')
    try {
      const stats = collectQueueStats()
      expect(stats.heldBackTotal).toBe(1)
      // No binding can be read, so nothing is attributed — but it still reports.
      expect(stats.heldBack![0].projectId).toBeNull()
    } finally {
      memDb.exec('CREATE TABLE IF NOT EXISTS SyncMaintenanceFlags (Key TEXT PRIMARY KEY, Value TEXT, UpdatedAt TEXT)')
    }
  })
})
