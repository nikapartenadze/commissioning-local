import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

function isTpeFamily(tagType: string): boolean {
  return tagType === 'TPE' || tagType.startsWith('TPE ')
}

function mergeFamilyModes(tagType: string, dbModes: string[]): string[] {
  if (!isTpeFamily(tagType)) return dbModes
  if (dbModes.includes('Needs alignment')) return dbModes
  return [...dbModes, 'Needs alignment']
}

export async function GET(req: Request, res: Response) {
  try {
    const tagType = req.query.tagType as string | undefined

    if (tagType) {
      const rows = db
        .prepare('SELECT FailureMode FROM TagTypeDiagnostics WHERE TagType = ? ORDER BY FailureMode ASC')
        .all(tagType) as { FailureMode: string }[]
      const modes = mergeFamilyModes(tagType, rows.map(d => d.FailureMode))
      return res.json(modes)
    }

    const rows = db
      .prepare('SELECT DISTINCT FailureMode FROM TagTypeDiagnostics ORDER BY FailureMode ASC')
      .all() as { FailureMode: string }[]
    return res.json(rows.map(d => d.FailureMode))
  } catch (error) {
    console.error('Failed to fetch failure modes:', error)
    return res.status(500).json({ error: 'Failed to fetch failure modes' })
  }
}
