/**
 * Runtime schema sanity check (2026-07-08, requested by ops after the FV
 * incident): "ping the db with a query every now and then that asks — are the
 * tables I expect still there, and ones I don't expect not?"
 *
 * Verifies, at startup and every 6 hours:
 *   1. Every CRITICAL table exists.
 *   2. Critical columns exist on the tables sync/data-safety depends on.
 *   3. Regression guards on DDL shape — e.g. TestHistories must NOT carry the
 *      FK ON DELETE CASCADE that used to erase the audit ledger on pulls.
 *   4. PRAGMA quick_check — fast corruption sniff (not a full integrity_check).
 *
 * Problems are journaled (recovery JSONL, type 'db.sanity'), logged loudly, and
 * exposed via getLastSanity() so /api/health can surface them to the fleet and
 * the battle observer. Never throws; a sanity failure must not take the app down
 * — its whole job is to make silent drift visible.
 */

import { db } from '@/lib/db-sqlite'
import { auditLog } from '@/lib/logging/recovery-log'

/** Tables the tool cannot operate safely without. */
const CRITICAL_TABLES = [
  'Projects', 'Subsystems', 'Ios', 'TestHistories', 'PendingSyncs',
  'L2Sheets', 'L2Columns', 'L2Devices', 'L2CellValues', 'L2PendingSyncs',
  'EStopZones', 'EStopEpcChecks', 'EStopCheckPendingSyncs',
  'SyncCursors', 'ChangeRequests',
] as const

/** Columns whose absence means a migration failed or the DB was swapped out. */
const CRITICAL_COLUMNS: Record<string, string[]> = {
  Ios: ['Result', 'Version', 'SubsystemId', 'Comments'],
  TestHistories: ['IoId', 'Result', 'Timestamp'],
  PendingSyncs: ['IoId', 'TestResult', 'Version', 'DeadLettered'],
  L2CellValues: ['DeviceId', 'ColumnId', 'Value', 'Version'],
  L2Devices: ['CloudId', 'SheetId', 'SubsystemId'],
  L2PendingSyncs: ['CloudDeviceId', 'CloudColumnId', 'DeadLettered'],
  EStopEpcChecks: ['SubsystemId', 'ZoneName', 'CheckTag', 'CheckType', 'Version'],
}

/** DDL shapes that must never come back (each was a shipped data-loss bug). */
const FORBIDDEN_DDL: Array<{ table: string; pattern: RegExp; why: string }> = [
  {
    table: 'TestHistories',
    pattern: /ON DELETE CASCADE/i,
    why: 'FK cascade erases the local audit ledger on every IO rewrite (fixed 2026-07-08)',
  },
]

export interface SanityResult {
  ok: boolean
  checkedAt: string
  problems: string[]
}

let lastResult: SanityResult | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function getLastSanity(): SanityResult | null {
  return lastResult
}

export function runSchemaSanity(): SanityResult {
  const problems: string[] = []
  try {
    const rows = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table'"
    ).all() as Array<{ name: string; sql: string | null }>
    const byName = new Map(rows.map((r) => [r.name, r.sql || '']))

    for (const t of CRITICAL_TABLES) {
      if (!byName.has(t)) problems.push(`missing table: ${t}`)
    }

    for (const [table, cols] of Object.entries(CRITICAL_COLUMNS)) {
      if (!byName.has(table)) continue // already reported above
      try {
        const have = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
        )
        for (const col of cols) {
          if (!have.has(col)) problems.push(`missing column: ${table}.${col}`)
        }
      } catch (e) {
        problems.push(`table_info failed: ${table}: ${(e as Error).message}`)
      }
    }

    for (const rule of FORBIDDEN_DDL) {
      const ddl = byName.get(rule.table)
      if (ddl && rule.pattern.test(ddl)) {
        problems.push(`forbidden DDL on ${rule.table}: ${rule.why}`)
      }
    }

    try {
      const qc = db.pragma('quick_check', { simple: true })
      if (String(qc).toLowerCase() !== 'ok') problems.push(`quick_check: ${String(qc).slice(0, 200)}`)
    } catch (e) {
      problems.push(`quick_check failed to run: ${(e as Error).message}`)
    }
  } catch (e) {
    problems.push(`sanity sweep failed: ${(e as Error).message}`)
  }

  const result: SanityResult = { ok: problems.length === 0, checkedAt: new Date().toISOString(), problems }
  lastResult = result

  if (!result.ok) {
    console.error(`[SchemaSanity] PROBLEMS DETECTED (${problems.length}): ${problems.join(' | ')}`)
    auditLog({ type: 'db.sanity', reason: 'schema drift detected', detail: { problems } })
  } else {
    console.log('[SchemaSanity] OK — all critical tables/columns present, quick_check clean')
  }
  return result
}

/** Run once shortly after boot, then every 6 hours. Idempotent. */
export function startSchemaSanity(): void {
  if (timer) return
  setTimeout(() => { try { runSchemaSanity() } catch { /* never throw */ } }, 15_000)
  timer = setInterval(() => { try { runSchemaSanity() } catch { /* never throw */ } }, 6 * 60 * 60 * 1000)
}

export function stopSchemaSanity(): void {
  if (timer) { clearInterval(timer); timer = null }
}
