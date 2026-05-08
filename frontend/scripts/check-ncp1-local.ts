import { db } from '@/lib/db-sqlite'

const dev = db.prepare(`
  SELECT d.id, d.DeviceName, d.SheetId, d.CloudId, s.Name as SheetName
  FROM L2Devices d
  JOIN L2Sheets s ON d.SheetId = s.id
  WHERE LOWER(d.DeviceName) = 'ncp1_1_vfd'
`).all() as Array<{ id: number; DeviceName: string; SheetId: number; CloudId: number; SheetName: string }>

console.log('NCP1_1_VFD local rows:', dev.length)
for (const d of dev) {
  console.log(`  device.id=${d.id} cloudId=${d.CloudId} sheet=${d.SheetName}`)
  const cells = db.prepare(`
    SELECT lc.Name, lc.id as colId, lc.CloudId as colCloudId, cv.Value, cv.Version, cv.UpdatedBy, cv.UpdatedAt
    FROM L2Columns lc
    LEFT JOIN L2CellValues cv ON cv.ColumnId = lc.id AND cv.DeviceId = ?
    WHERE lc.SheetId = ?
    ORDER BY lc.DisplayOrder
  `).all(d.id, d.SheetId) as Array<{ Name: string; colId: number; colCloudId: number; Value: string | null; Version: number | null; UpdatedBy: string | null; UpdatedAt: string | null }>
  for (const c of cells) {
    console.log(`    [col=${c.colId} cloudCol=${c.colCloudId}] ${c.Name.padEnd(25)} value=${JSON.stringify(c.Value)} v=${c.Version ?? '-'} by=${c.UpdatedBy ?? '-'} at=${c.UpdatedAt ?? '-'}`)
  }
}

console.log('\nL2PendingSyncs for NCP1_1_VFD:')
const pending = db.prepare(`
  SELECT ps.id, ps.CloudDeviceId, ps.CloudColumnId, ps.Value, ps.Version, ps.RetryCount, ps.LastError, ps.CreatedAt, lc.Name as ColName
  FROM L2PendingSyncs ps
  LEFT JOIN L2Columns lc ON lc.CloudId = ps.CloudColumnId
  WHERE ps.CloudDeviceId IN (SELECT CloudId FROM L2Devices WHERE LOWER(DeviceName) = 'ncp1_1_vfd')
  ORDER BY ps.id
`).all() as Array<{ id: number; CloudDeviceId: number; CloudColumnId: number; Value: string | null; Version: number; RetryCount: number; LastError: string | null; CreatedAt: string; ColName: string | null }>
for (const p of pending) {
  console.log(`  id=${p.id} ${(p.ColName ?? '?').padEnd(20)} pendingValue=${JSON.stringify(p.Value)} storedBase=${p.Version} retries=${p.RetryCount} err=${p.LastError ?? '-'} created=${p.CreatedAt}`)
}
