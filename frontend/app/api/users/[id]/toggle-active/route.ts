export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { requireAdmin } from '@/lib/auth/middleware'
import { revokeTokensForUser } from '@/lib/auth/jwt'

interface UserRow {
  id: number;
  FullName: string;
  IsAdmin: number;
  IsActive: number;
}

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

  const target = db.prepare('SELECT id, FullName, IsAdmin, IsActive FROM Users WHERE id = ?').get(id) as UserRow | undefined
  if (!target) {
    return NextResponse.json({ message: 'User not found' }, { status: 404 })
  }

  if (target.IsAdmin) {
    return NextResponse.json({ message: 'Cannot deactivate admin users' }, { status: 403 })
  }

  const newIsActive = target.IsActive ? 0 : 1
  db.prepare('UPDATE Users SET IsActive = ? WHERE id = ?').run(newIsActive, id)

  const updated = {
    id: target.id,
    fullName: target.FullName,
    isActive: !!newIsActive,
  }

  // Revoke active tokens when user is deactivated
  if (!updated.isActive) {
    revokeTokensForUser(id.toString())
  }

  return NextResponse.json(updated)
}
