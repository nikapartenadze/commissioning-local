export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth/middleware'
import { revokeTokensForUser } from '@/lib/auth/jwt'

// PUT /api/users/[id]/toggle-active — toggle user active status (admin only)
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authError = requireAdmin(request)
  if (authError) return authError

  const id = parseInt(params.id, 10)
  if (isNaN(id)) {
    return NextResponse.json({ message: 'Invalid user ID' }, { status: 400 })
  }

  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) {
    return NextResponse.json({ message: 'User not found' }, { status: 404 })
  }

  if (target.isAdmin) {
    return NextResponse.json({ message: 'Cannot deactivate admin users' }, { status: 403 })
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: !target.isActive },
    select: {
      id: true,
      fullName: true,
      isActive: true,
    },
  })

  // Revoke active tokens when user is deactivated
  if (!updated.isActive) {
    revokeTokensForUser(id.toString())
  }

  return NextResponse.json(updated)
}
