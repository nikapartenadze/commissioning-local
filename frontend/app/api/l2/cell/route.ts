import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

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

      if (device?.CloudId && column?.CloudId) {
        // Queue for cloud sync
        db.prepare(
          'INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version) VALUES (?, ?, ?, ?, ?)'
        ).run(device.CloudId, column.CloudId, value ?? null, updatedBy ?? null, newVersion - 1)
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

      return { cellId, version: newVersion, completedChecks: completedCount?.cnt || 0 }
    })()

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('[L2 Cell] Error:', error)
    return NextResponse.json({ error: 'Failed to save cell' }, { status: 500 })
  }
}
