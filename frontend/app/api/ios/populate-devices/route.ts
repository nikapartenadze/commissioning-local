export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db, extractDeviceName } from '@/lib/db-sqlite'

export async function POST() {
  try {
    const ios = db.prepare(
      "SELECT id, Name FROM Ios WHERE Name IS NOT NULL"
    ).all() as { id: number; Name: string }[]

    const groups = new Map<string, number[]>()
    for (const io of ios) {
      const deviceName = extractDeviceName(io.Name)
      if (!deviceName) continue

      const ids = groups.get(deviceName) ?? []
      ids.push(io.id)
      groups.set(deviceName, ids)
    }

    let updatedCount = 0
    const updateStmt = db.prepare(
      'UPDATE Ios SET NetworkDeviceName = ? WHERE id = ?'
    )
    const txn = db.transaction(() => {
      for (const [deviceName, ids] of Array.from(groups.entries())) {
        for (const id of ids) {
          updateStmt.run(deviceName, id)
          updatedCount++
        }
      }
    })
    txn()

    return NextResponse.json({
      success: true,
      updatedCount,
      deviceGroups: groups.size,
    })
  } catch (error) {
    console.error('Failed to populate device names:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to populate device names' },
      { status: 500 }
    )
  }
}
