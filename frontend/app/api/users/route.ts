export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { withAdmin } from '@/lib/auth/middleware'
import { hashPin } from '@/lib/auth/password'

interface UserRow {
  id: number;
  FullName: string;
  IsAdmin: number;
  IsActive: number;
  CreatedAt: string | null;
  LastUsedAt: string | null;
}

// GET /api/users — list all users (admin only)
export const GET = withAdmin(async () => {
  const rows = db.prepare(
    'SELECT id, FullName, IsAdmin, IsActive, CreatedAt, LastUsedAt FROM Users ORDER BY FullName ASC'
  ).all() as UserRow[]

  const users = rows.map(r => ({
    id: r.id,
    fullName: r.FullName,
    isAdmin: !!r.IsAdmin,
    isActive: !!r.IsActive,
    createdAt: r.CreatedAt,
    lastUsedAt: r.LastUsedAt,
  }))

  return NextResponse.json(users)
})

// POST /api/users — create a new user (admin only)
export const POST = withAdmin(async (request: NextRequest) => {
  const body = await request.json()
  const { fullName, pin } = body

  if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
    return NextResponse.json({ message: 'Full name is required' }, { status: 400 })
  }

  if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    return NextResponse.json({ message: 'PIN must be exactly 6 digits' }, { status: 400 })
  }

  // Check for duplicate name
  const existing = db.prepare('SELECT id FROM Users WHERE FullName = ?').get(fullName.trim())
  if (existing) {
    return NextResponse.json({ message: 'A user with this name already exists' }, { status: 409 })
  }

  const hashedPin = await hashPin(pin)
  const now = new Date().toISOString()

  const result = db.prepare(
    'INSERT INTO Users (FullName, Pin, IsAdmin, IsActive, CreatedAt) VALUES (?, ?, 0, 1, ?)'
  ).run(fullName.trim(), hashedPin, now)

  const user = {
    id: result.lastInsertRowid as number,
    fullName: fullName.trim(),
    isAdmin: false,
    isActive: true,
    createdAt: now,
  }

  return NextResponse.json(user, { status: 201 })
})
