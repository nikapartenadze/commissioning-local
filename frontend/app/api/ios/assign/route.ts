import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { requireAdmin } from '@/lib/auth/middleware'

/**
 * PUT /api/ios/assign
 * Bulk assign IOs to a user
 * Body: { ioIds: number[], assignedTo: string | null }
 */
export async function PUT(request: NextRequest) {
  const authError = requireAdmin(request)
  if (authError) return authError

  try {
    const { ioIds, assignedTo } = await request.json()

    if (!Array.isArray(ioIds) || ioIds.length === 0) {
      return NextResponse.json({ error: 'ioIds must be a non-empty array' }, { status: 400 })
    }

    const placeholders = ioIds.map(() => '?').join(', ')
    const result = db.prepare(
      `UPDATE Ios SET AssignedTo = ? WHERE id IN (${placeholders})`
    ).run(assignedTo || null, ...ioIds)

    return NextResponse.json({ updated: result.changes })
  } catch (error) {
    console.error('Error assigning IOs:', error)
    return NextResponse.json({ error: 'Failed to assign IOs' }, { status: 500 })
  }
}
