import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function POST(req: Request, res: Response) {
  try {
    const { ioId } = req.body

    console.log(`Firing output for IO ID: ${ioId}`)

    db.prepare('UPDATE Ios SET Timestamp = ? WHERE id = ?').run(new Date().toISOString(), ioId)

    return res.json({
      success: true,
      message: `Output fired for IO ${ioId}`
    })
  } catch (error) {
    console.error('Failed to fire output:', error)
    return res.status(500).json({ success: false, error: 'Failed to fire output' })
  }
}
