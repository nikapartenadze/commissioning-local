export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { requireAdmin } from '@/lib/auth/middleware'
import { hashPin } from '@/lib/auth/password'
import { revokeTokensForUser } from '@/lib/auth/jwt'

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

  const target = db.prepare('SELECT id FROM Users WHERE id = ?').get(id)
  if (!target) {
    return NextResponse.json({ message: 'User not found' }, { status: 404 })
  }

  const hashedPin = await hashPin(newPin)

  db.prepare('UPDATE Users SET Pin = ? WHERE id = ?').run(hashedPin, id)

  // Revoke active tokens to force re-login with new PIN
  revokeTokensForUser(id.toString())

  return NextResponse.json({ success: true })
}
