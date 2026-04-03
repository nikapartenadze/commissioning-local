export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

/**
 * GET /api/punchlists?subsystemId=X
 *
 * Returns punchlists from local SQLite with their IO IDs and progress stats.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const subsystemId = searchParams.get('subsystemId')

    if (!subsystemId) {
      return NextResponse.json([], { status: 200 })
    }

    // Get all punchlists for this subsystem
    const punchlists = db.prepare(
      'SELECT id, Name FROM Punchlists WHERE SubsystemId = ? ORDER BY Name'
    ).all(parseInt(subsystemId, 10)) as Array<{ id: number; Name: string }>

    if (punchlists.length === 0) {
      return NextResponse.json([])
    }

    // For each punchlist, get IO IDs and compute progress stats
    const getItemsStmt = db.prepare(
      'SELECT IoId FROM PunchlistItems WHERE PunchlistId = ?'
    )
    const getIoStatsStmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN Result = 'Passed' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN Result = 'Failed' THEN 1 ELSE 0 END) as failed
      FROM Ios
      WHERE id IN (SELECT IoId FROM PunchlistItems WHERE PunchlistId = ?)
    `)

    const result = punchlists.map(pl => {
      const items = getItemsStmt.all(pl.id) as Array<{ IoId: number }>
      const ioIds = items.map(item => item.IoId)
      const stats = getIoStatsStmt.get(pl.id) as { total: number; passed: number; failed: number } | undefined

      return {
        id: pl.id,
        name: pl.Name,
        ioIds,
        total: stats?.total ?? 0,
        passed: stats?.passed ?? 0,
        failed: stats?.failed ?? 0,
      }
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error('[Punchlists] Error fetching punchlists:', error)
    return NextResponse.json([], { status: 200 })
  }
}
