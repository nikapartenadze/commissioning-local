/**
 * One-shot — drop pending L2 syncs that have failed enough times that a
 * push from the current local Version-1 base will never line up with the
 * cloud's current Version (the version-conflict death spiral documented
 * in 2026-04-21-sync-incident-and-fixes.md).
 *
 * Local cell values are kept; only the pending-push row is removed. Any
 * future write to the cell creates a fresh pending row at the correct
 * Version and pushes cleanly.
 *
 * Usage:
 *   npx tsx scripts/unstick-pending-syncs.ts            # dry-run, list rows
 *   IMPORT_CONFIRM=YES npx tsx scripts/unstick-pending-syncs.ts   # delete
 */
import { db } from '@/lib/db-sqlite'

const APPLY = process.env.IMPORT_CONFIRM === 'YES'

const rows = db.prepare(`
  SELECT id, CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version, RetryCount, LastError
  FROM L2PendingSyncs
  ORDER BY id
`).all() as Array<{
  id: number; CloudDeviceId: number; CloudColumnId: number; Value: string | null
  UpdatedBy: string | null; Version: number; RetryCount: number; LastError: string | null
}>

console.log(`L2PendingSyncs has ${rows.length} row(s):`)
for (const r of rows) {
  console.log(`  id=${r.id} cloudDev=${r.CloudDeviceId} cloudCol=${r.CloudColumnId} v=${r.Version} retries=${r.RetryCount} value=${JSON.stringify(r.Value)} err=${r.LastError ?? '-'}`)
}
if (rows.length === 0) { process.exit(0) }

if (!APPLY) {
  console.log('\n(dry-run — set IMPORT_CONFIRM=YES to delete all pending sync rows)')
  process.exit(0)
}

const result = db.prepare('DELETE FROM L2PendingSyncs').run()
console.log(`Deleted ${result.changes} row(s) from L2PendingSyncs.`)
console.log('Restart the dev server so the in-memory sync queue clears, then re-pull.')
