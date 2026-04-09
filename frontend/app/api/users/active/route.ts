import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

interface UserRow {
  id: number;
  FullName: string;
  IsAdmin: number;
  LastUsedAt: string | null;
}

export async function GET(req: Request, res: Response) {
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

    return res.json(users)
  } catch (error) {
    console.error('Failed to get active users:', error)
    return res.json([])
  }
}
