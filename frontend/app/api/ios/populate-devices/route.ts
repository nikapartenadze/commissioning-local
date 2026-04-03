export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function POST() {
  try {
    // Fetch all IOs where NetworkDeviceName is null and Name contains ':'
    const ios = db.prepare(
      "SELECT id, Name FROM Ios WHERE NetworkDeviceName IS NULL AND Name LIKE '%:%'"
    ).all() as { id: number; Name: string }[]

    // Group IOs by their device prefix for efficient batch updates
    const groups = new Map<string, number[]>()
    for (const io of ios) {
      const colonIndex = io.Name.indexOf(':')
      const deviceName = io.Name.substring(0, colonIndex)
      if (!deviceName) continue

      const ids = groups.get(deviceName) ?? []
      ids.push(io.id)
      groups.set(deviceName, ids)
    }

    // Batch update each group
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
