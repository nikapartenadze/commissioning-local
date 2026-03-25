import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
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

    const result = await prisma.io.updateMany({
      where: { id: { in: ioIds } },
      data: { assignedTo: assignedTo || null },
    })

    return NextResponse.json({ updated: result.count })
  } catch (error) {
    console.error('Error assigning IOs:', error)
    return NextResponse.json({ error: 'Failed to assign IOs' }, { status: 500 })
  }
}
