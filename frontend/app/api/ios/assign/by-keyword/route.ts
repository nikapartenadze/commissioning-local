import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { requireAdmin } from '@/lib/auth/middleware'

/**
 * PUT /api/ios/assign/by-keyword
 * Assign IOs matching a keyword pattern to a user
 * Body: { keyword: string, assignedTo: string | null }
 * Matches keyword against IO name and description (case-insensitive)
 */
export async function PUT(request: NextRequest) {
  const authError = requireAdmin(request)
  if (authError) return authError

  try {
    const { keyword, assignedTo } = await request.json()

    if (!keyword || typeof keyword !== 'string') {
      return NextResponse.json({ error: 'keyword is required' }, { status: 400 })
    }

    const pattern = `%${keyword}%`
    const result = db.prepare(
      'UPDATE Ios SET AssignedTo = ? WHERE Name LIKE ? OR Description LIKE ?'
    ).run(assignedTo || null, pattern, pattern)

    return NextResponse.json({ updated: result.changes, keyword })
  } catch (error) {
    console.error('Error assigning IOs by keyword:', error)
    return NextResponse.json({ error: 'Failed to assign IOs by keyword' }, { status: 500 })
  }
}
