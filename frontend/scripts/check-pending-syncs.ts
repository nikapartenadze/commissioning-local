import { db } from '@/lib/db-sqlite'

const rows = db.prepare(`
  SELECT id, CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version, RetryCount, LastError
  FROM L2PendingSyncs
  ORDER BY id
`).all() as Array<{
  id: number; CloudDeviceId: number; CloudColumnId: number; Value: string | null
  UpdatedBy: string | null; Version: number; RetryCount: number; LastError: string | null
}>

console.log(`L2PendingSyncs: ${rows.length} rows`)
for (const r of rows) {
  console.log(`  id=${r.id} cloudDev=${r.CloudDeviceId} cloudCol=${r.CloudColumnId} v=${r.Version} retries=${r.RetryCount} value=${JSON.stringify(r.Value)} err=${r.LastError ? r.LastError.slice(0, 100) : '-'}`)
}
