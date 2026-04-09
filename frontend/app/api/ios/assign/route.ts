import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * PUT /api/ios/assign
 */
export async function PUT(req: Request, res: Response) {
  try {
    const { ioIds, assignedTo } = req.body

    if (!Array.isArray(ioIds) || ioIds.length === 0) {
      return res.status(400).json({ error: 'ioIds must be a non-empty array' })
    }

    const placeholders = ioIds.map(() => '?').join(', ')
    const result = db.prepare(
      `UPDATE Ios SET AssignedTo = ? WHERE id IN (${placeholders})`
    ).run(assignedTo || null, ...ioIds)

    return res.json({ updated: result.changes })
  } catch (error) {
    console.error('Error assigning IOs:', error)
    return res.status(500).json({ error: 'Failed to assign IOs' })
  }
}
