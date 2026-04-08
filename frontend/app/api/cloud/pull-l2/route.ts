import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function POST(request: Request) {
  try {
    const { remoteUrl, apiPassword, subsystemId } = await request.json()

    if (!remoteUrl || !apiPassword || !subsystemId) {
      return NextResponse.json({ error: 'Missing config' }, { status: 400 })
    }

    // Fetch L2 data from cloud
    const response = await fetch(`${remoteUrl}/api/sync/l2/${subsystemId}`, {
      headers: { 'X-API-Key': apiPassword }
    })

    if (!response.ok) {
      // L2 data might not exist yet — that's fine
      if (response.status === 404) {
        return NextResponse.json({ success: true, message: 'No L2 data available', sheetsCount: 0, devicesCount: 0 })
      }
      return NextResponse.json({ error: `Cloud returned ${response.status}` }, { status: 502 })
    }

    const data = await response.json()
    if (!data.success || !data.sheets) {
      return NextResponse.json({ success: true, message: 'No L2 template', sheetsCount: 0, devicesCount: 0 })
    }

    // Clear existing L2 data and re-insert
    const result = db.transaction(() => {
      db.exec('DELETE FROM L2PendingSyncs')
      db.exec('DELETE FROM L2CellValues')
      db.exec('DELETE FROM L2Devices')
      db.exec('DELETE FROM L2Columns')
      db.exec('DELETE FROM L2Sheets')

      let sheetsCount = 0
      let devicesCount = 0
      let cellsCount = 0

      // Map cloud IDs to local IDs
      const sheetIdMap = new Map<number, number>() // cloud sheet id → local id
      const columnIdMap = new Map<number, number>() // cloud column id → local id
      const deviceIdMap = new Map<number, number>() // cloud device id → local id

      // Insert sheets
      const insertSheet = db.prepare(
        'INSERT INTO L2Sheets (CloudId, Name, DisplayName, DisplayOrder, Discipline, DeviceCount) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const sheet of data.sheets) {
        const result = insertSheet.run(sheet.id, sheet.name, sheet.displayName, sheet.displayOrder, sheet.discipline, sheet.deviceCount || 0)
        sheetIdMap.set(sheet.id, result.lastInsertRowid as number)
        sheetsCount++

        // Insert columns for this sheet
        if (sheet.columns) {
          const insertCol = db.prepare(
            'INSERT INTO L2Columns (CloudId, SheetId, Name, ColumnType, DisplayOrder, IsRequired) VALUES (?, ?, ?, ?, ?, ?)'
          )
          for (const col of sheet.columns) {
            const colResult = insertCol.run(col.id, result.lastInsertRowid, col.name, col.columnType, col.displayOrder, col.isRequired ? 1 : 0)
            columnIdMap.set(col.id, colResult.lastInsertRowid as number)
          }
        }
      }

      // Insert devices
      const insertDevice = db.prepare(
        'INSERT INTO L2Devices (CloudId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder, CompletedChecks, TotalChecks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const device of (data.devices || [])) {
        const localSheetId = sheetIdMap.get(device.sheetId)
        if (!localSheetId) continue
        const devResult = insertDevice.run(
          device.id, localSheetId, device.deviceName, device.mcm, device.subsystem,
          device.displayOrder, device.completedChecks || 0, device.totalChecks || 0
        )
        deviceIdMap.set(device.id, devResult.lastInsertRowid as number)
        devicesCount++
      }

      // Insert cell values
      const insertCell = db.prepare(
        'INSERT OR REPLACE INTO L2CellValues (CloudCellId, DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const cell of (data.cellValues || [])) {
        const localDeviceId = deviceIdMap.get(cell.deviceId)
        const localColumnId = columnIdMap.get(cell.columnId)
        if (!localDeviceId || !localColumnId) continue
        insertCell.run(cell.id, localDeviceId, localColumnId, cell.value, cell.updatedBy, cell.updatedAt, Number(cell.version) || 0)
        cellsCount++
      }

      return { sheetsCount, devicesCount, cellsCount }
    })()

    return NextResponse.json({
      success: true,
      sheetsCount: result.sheetsCount,
      devicesCount: result.devicesCount,
      cellsCount: result.cellsCount
    })
  } catch (error) {
    console.error('[Pull L2] Error:', error)
    return NextResponse.json({ error: 'Failed to pull L2 data' }, { status: 500 })
  }
}
