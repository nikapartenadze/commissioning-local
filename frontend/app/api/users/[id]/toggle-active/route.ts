import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { revokeTokensForUser } from '@/lib/auth/jwt'

interface UserRow {
  id: number;
  FullName: string;
  IsAdmin: number;
  IsActive: number;
}

// PUT /api/users/:id/toggle-active — toggle user active status (admin only)
export async function PUT(req: Request, res: Response) {
  const id = parseInt(req.params.id as string, 10)
  if (isNaN(id)) {
    return res.status(400).json({ message: 'Invalid user ID' })
  }

  const target = db.prepare('SELECT id, FullName, IsAdmin, IsActive FROM Users WHERE id = ?').get(id) as UserRow | undefined
  if (!target) {
    return res.status(404).json({ message: 'User not found' })
  }

  if (target.IsAdmin) {
    return res.status(403).json({ message: 'Cannot deactivate admin users' })
  }

  const newIsActive = target.IsActive ? 0 : 1
  db.prepare('UPDATE Users SET IsActive = ? WHERE id = ?').run(newIsActive, id)

  const updated = {
    id: target.id,
    fullName: target.FullName,
    isActive: !!newIsActive,
  }

  if (!updated.isActive) {
    revokeTokensForUser(id.toString())
  }

  return res.json(updated)
}
