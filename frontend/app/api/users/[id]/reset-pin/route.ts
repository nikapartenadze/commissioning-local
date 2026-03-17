export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth/middleware'
import { hashPin } from '@/lib/auth/password'

// PUT /api/users/[id]/reset-pin — reset a user's PIN (admin only)
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

  const body = await request.json()
  const { newPin } = body

  if (!newPin || typeof newPin !== 'string' || !/^\d{6}$/.test(newPin)) {
    return NextResponse.json({ message: 'New PIN must be exactly 6 digits' }, { status: 400 })
  }

  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) {
    return NextResponse.json({ message: 'User not found' }, { status: 404 })
  }

  const hashedPin = await hashPin(newPin)

  await prisma.user.update({
    where: { id },
    data: { pin: hashedPin },
  })

  return NextResponse.json({ success: true })
}
