import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
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
export async function GET(req: Request, res: Response) {
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

  return res.json(users)
}

// POST /api/users — create a new user (admin only)
export async function POST(req: Request, res: Response) {
  const body = req.body
  const { fullName, pin } = body

  if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
    return res.status(400).json({ message: 'Full name is required' })
  }

  if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    return res.status(400).json({ message: 'PIN must be exactly 6 digits' })
  }

  const existing = db.prepare('SELECT id FROM Users WHERE FullName = ?').get(fullName.trim())
  if (existing) {
    return res.status(409).json({ message: 'A user with this name already exists' })
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

  return res.status(201).json(user)
}
