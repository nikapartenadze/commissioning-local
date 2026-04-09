import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

interface UserRow {
  id: number;
  FullName: string;
  IsAdmin: number;
  IsActive: number;
}

// DELETE /api/users/:id — delete a user (admin only, cannot delete admins)
export async function DELETE(req: Request, res: Response) {
  const id = parseInt(req.params.id as string, 10)
  if (isNaN(id)) {
    return res.status(400).json({ message: 'Invalid user ID' })
  }

  const target = db.prepare('SELECT id, FullName, IsAdmin, IsActive FROM Users WHERE id = ?').get(id) as UserRow | undefined
  if (!target) {
    return res.status(404).json({ message: 'User not found' })
  }

  if (target.IsAdmin) {
    return res.status(403).json({ message: 'Cannot delete admin users' })
  }

  db.prepare('DELETE FROM Users WHERE id = ?').run(id)

  return res.json({ success: true })
}
