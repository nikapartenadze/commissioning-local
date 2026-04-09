import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { hashPin } from '@/lib/auth/password'
import { revokeTokensForUser } from '@/lib/auth/jwt'

// PUT /api/users/:id/reset-pin — reset a user's PIN (admin only)
export async function PUT(req: Request, res: Response) {
  const id = parseInt(req.params.id as string, 10)
  if (isNaN(id)) {
    return res.status(400).json({ message: 'Invalid user ID' })
  }

  const body = req.body
  const { newPin } = body

  if (!newPin || typeof newPin !== 'string' || !/^\d{6}$/.test(newPin)) {
    return res.status(400).json({ message: 'New PIN must be exactly 6 digits' })
  }

  const target = db.prepare('SELECT id FROM Users WHERE id = ?').get(id)
  if (!target) {
    return res.status(404).json({ message: 'User not found' })
  }

  const hashedPin = await hashPin(newPin)

  db.prepare('UPDATE Users SET Pin = ? WHERE id = ?').run(hashedPin, id)

  revokeTokensForUser(id.toString())

  return res.json({ success: true })
}
