import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * PUT /api/ios/assign/by-keyword
 */
export async function PUT(req: Request, res: Response) {
  try {
    const { keyword, assignedTo } = req.body

    if (!keyword || typeof keyword !== 'string') {
      return res.status(400).json({ error: 'keyword is required' })
    }

    const pattern = `%${keyword}%`
    const result = db.prepare(
      'UPDATE Ios SET AssignedTo = ? WHERE Name LIKE ? OR Description LIKE ?'
    ).run(assignedTo || null, pattern, pattern)

    return res.json({ updated: result.changes, keyword })
  } catch (error) {
    console.error('Error assigning IOs by keyword:', error)
    return res.status(500).json({ error: 'Failed to assign IOs by keyword' })
  }
}
