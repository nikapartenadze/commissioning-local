export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth/middleware'

// DELETE /api/users/[id] — delete a user (admin only, cannot delete admins)
export async function DELETE(
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
    return NextResponse.json({ message: 'Cannot delete admin users' }, { status: 403 })
  }

  await prisma.user.delete({ where: { id } })

  return NextResponse.json({ success: true })
}
