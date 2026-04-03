export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { requireAdmin } from '@/lib/auth/middleware'

interface UserRow {
  id: number;
  FullName: string;
  IsAdmin: number;
  IsActive: number;
}

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

  const target = db.prepare('SELECT id, FullName, IsAdmin, IsActive FROM Users WHERE id = ?').get(id) as UserRow | undefined
  if (!target) {
    return NextResponse.json({ message: 'User not found' }, { status: 404 })
  }

  if (target.IsAdmin) {
    return NextResponse.json({ message: 'Cannot delete admin users' }, { status: 403 })
  }

  db.prepare('DELETE FROM Users WHERE id = ?').run(id)

  return NextResponse.json({ success: true })
}
