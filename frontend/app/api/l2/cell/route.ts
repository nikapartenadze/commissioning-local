import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

export async function POST(request: Request) {
  try {
    const { deviceId, columnId, value, updatedBy } = await request.json()

    if (!deviceId || !columnId) {
      return NextResponse.json({ error: 'deviceId and columnId required' }, { status: 400 })
    }

    const result = db.transaction(() => {
      // Upsert cell value
      const existing = db.prepare(
        'SELECT id, Value, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'
      ).get(deviceId, columnId) as { id: number; Value: string | null; Version: number } | undefined

      let cellId: number
      let newVersion: number

      if (existing) {
        newVersion = existing.Version + 1
        db.prepare(
          'UPDATE L2CellValues SET Value = ?, UpdatedBy = ?, UpdatedAt = datetime("now"), Version = ? WHERE id = ?'
        ).run(value ?? null, updatedBy ?? null, newVersion, existing.id)
        cellId = existing.id
      } else {
        newVersion = 1
        const insertResult = db.prepare(
          'INSERT INTO L2CellValues (DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, datetime("now"), ?)'
        ).run(deviceId, columnId, value ?? null, updatedBy ?? null, newVersion)
        cellId = insertResult.lastInsertRowid as number
      }

      // Get cloud IDs for sync queue
      const device = db.prepare('SELECT CloudId FROM L2Devices WHERE id = ?').get(deviceId) as { CloudId: number } | undefined
      const column = db.prepare('SELECT CloudId FROM L2Columns WHERE id = ?').get(columnId) as { CloudId: number } | undefined

      let pendingSyncId: number | null = null
      if (device?.CloudId && column?.CloudId) {
        // Queue for cloud sync (fallback if instant push fails)
        const syncResult = db.prepare(
          'INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version) VALUES (?, ?, ?, ?, ?)'
        ).run(device.CloudId, column.CloudId, value ?? null, updatedBy ?? null, newVersion - 1)
        pendingSyncId = syncResult.lastInsertRowid as number
      }

      // Update completed_checks on the device
      const checkColumns = db.prepare(
        'SELECT id FROM L2Columns WHERE SheetId = (SELECT SheetId FROM L2Devices WHERE id = ?) AND ColumnType = "check"'
      ).all(deviceId) as { id: number }[]

      const completedCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM L2CellValues
         WHERE DeviceId = ? AND ColumnId IN (${checkColumns.map(c => c.id).join(',') || '0'})
         AND Value IS NOT NULL AND Value != ''`
      ).get(deviceId) as { cnt: number }

      db.prepare('UPDATE L2Devices SET CompletedChecks = ? WHERE id = ?')
        .run(completedCount?.cnt || 0, deviceId)

      return {
        cellId,
        version: newVersion,
        completedChecks: completedCount?.cnt || 0,
        cloudDeviceId: device?.CloudId,
        cloudColumnId: column?.CloudId,
        pendingSyncId,
      }
    })()

    // Instant push to cloud (non-blocking — don't hold up the response)
    if (result.cloudDeviceId && result.cloudColumnId) {
      tryInstantL2Push(
        result.cloudDeviceId,
        result.cloudColumnId,
        value ?? null,
        result.version - 1,
        updatedBy,
        result.pendingSyncId
      )
    }

    return NextResponse.json({ success: true, cellId: result.cellId, version: result.version, completedChecks: result.completedChecks })
  } catch (error) {
    console.error('[L2 Cell] Error:', error)
    return NextResponse.json({ error: 'Failed to save cell' }, { status: 500 })
  }
}

/** Try to push L2 cell update to cloud immediately. On success, remove from pending queue. */
async function tryInstantL2Push(
  cloudDeviceId: number,
  cloudColumnId: number,
  value: string | null,
  version: number,
  updatedBy: string | null,
  pendingSyncId: number | null,
) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    if (!remoteUrl) return

    const resp = await fetch(`${remoteUrl}/api/sync/l2/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
      body: JSON.stringify({
        updates: [{
          deviceId: cloudDeviceId,
          columnId: cloudColumnId,
          value,
          version,
          updatedBy: updatedBy || 'unknown',
        }]
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (resp.ok && pendingSyncId) {
      // Success — remove from pending queue since it's already synced
      try {
        db.prepare('DELETE FROM L2PendingSyncs WHERE id = ?').run(pendingSyncId)
      } catch { /* ignore */ }
    }
  } catch {
    // Failed — auto-sync will retry from the queue
  }
}
