import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { hashPin, verifyPin } from '@/lib/auth/password'
import { generateToken, revokeTokensForUser } from '@/lib/auth/jwt'

interface UserRow {
  id: number
  FullName: string
  Pin: string
  IsAdmin: number
  IsActive: number
  MustChangePin?: number
}

/**
 * POST /api/auth/change-pin — the currently-authenticated user changes their
 * OWN PIN. Used by the first-run must-change-PIN flow (seeded admin) and any
 * routine self-service PIN change.
 *
 * Mounted behind authMiddleware so req.user is the caller. We change only the
 * caller's own row (req.user.sub), require the current PIN, and clear the
 * must-change flag. A fresh token is returned so the client keeps a valid
 * session after the old tokens are revoked.
 */
export async function POST(req: Request, res: Response) {
  const user = req.user
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const id = parseInt(user.sub, 10)
  if (isNaN(id)) {
    return res.status(400).json({ message: 'Invalid session' })
  }

  const body = req.body || {}
  const currentPin: string | undefined = body.currentPin
  const newPin: string | undefined = body.newPin

  if (!newPin || typeof newPin !== 'string' || !/^\d{6}$/.test(newPin)) {
    return res.status(400).json({ message: 'New PIN must be exactly 6 digits' })
  }

  const row = db.prepare('SELECT * FROM Users WHERE id = ?').get(id) as UserRow | undefined
  if (!row || !row.IsActive) {
    return res.status(404).json({ message: 'User not found' })
  }

  // Require the current PIN to authorize the change.
  if (!currentPin || !(await verifyPin(currentPin, row.Pin))) {
    return res.status(401).json({ message: 'Current PIN is incorrect' })
  }

  if (await verifyPin(newPin, row.Pin)) {
    return res.status(400).json({ message: 'New PIN must differ from the current PIN' })
  }

  const hashedPin = await hashPin(newPin)
  try {
    db.prepare('UPDATE Users SET Pin = ?, MustChangePin = 0 WHERE id = ?').run(hashedPin, id)
  } catch {
    db.prepare('UPDATE Users SET Pin = ? WHERE id = ?').run(hashedPin, id)
  }

  // Revoke the old session(s), then mint a fresh token so the caller stays
  // logged in seamlessly after the change.
  revokeTokensForUser(id.toString())
  const token = generateToken({ id, fullName: row.FullName, isAdmin: !!row.IsAdmin })

  return res.json({
    success: true,
    fullName: row.FullName,
    isAdmin: !!row.IsAdmin,
    mustChangePin: false,
    token,
  })
}
