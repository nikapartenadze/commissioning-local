import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const tagType = req.query.tagType as string | undefined

    if (tagType) {
      const rows = db.prepare('SELECT FailureMode FROM TagTypeDiagnostics WHERE TagType = ? ORDER BY FailureMode ASC').all(tagType) as { FailureMode: string }[]
      return res.json(rows.map(d => d.FailureMode))
    }

    const rows = db.prepare('SELECT DISTINCT FailureMode FROM TagTypeDiagnostics ORDER BY FailureMode ASC').all() as { FailureMode: string }[]
    return res.json(rows.map(d => d.FailureMode))
  } catch (error) {
    console.error('Failed to fetch failure modes:', error)
    return res.status(500).json({ error: 'Failed to fetch failure modes' })
  }
}
