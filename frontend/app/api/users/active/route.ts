export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { requireAuth } from '@/lib/auth/middleware'

interface UserRow {
  id: number;
  FullName: string;
  IsAdmin: number;
  LastUsedAt: string | null;
}

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request)
  if (authError) return authError

  try {
    const rows = db.prepare(
      'SELECT id, FullName, IsAdmin, LastUsedAt FROM Users ORDER BY LastUsedAt DESC'
    ).all() as UserRow[]

    const users = rows.map(r => ({
      id: r.id,
      fullName: r.FullName,
      isAdmin: !!r.IsAdmin,
      lastUsedAt: r.LastUsedAt,
    }))

    return NextResponse.json(users)
  } catch (error) {
    console.error('Failed to get active users:', error)
    return NextResponse.json([])
  }
}
