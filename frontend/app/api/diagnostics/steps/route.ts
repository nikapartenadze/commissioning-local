import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

interface DiagnosticRow { TagType: string; FailureMode: string; DiagnosticSteps: string; }

export async function GET(req: Request, res: Response) {
  try {
    const tagType = req.query.tagType as string | undefined
    const failureMode = req.query.failureMode as string | undefined

    if (!tagType) {
      return res.status(400).json({ error: 'tagType parameter is required' })
    }

    if (failureMode) {
      const diagnostic = db.prepare('SELECT * FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?').get(tagType, failureMode) as DiagnosticRow | undefined
      if (!diagnostic) {
        return res.status(404).json({ error: 'No diagnostic steps found for this tag type and failure mode' })
      }
      return res.json({ steps: diagnostic.DiagnosticSteps })
    }

    const diagnostics = db.prepare('SELECT * FROM TagTypeDiagnostics WHERE TagType = ? ORDER BY FailureMode ASC').all(tagType) as DiagnosticRow[]
    if (diagnostics.length === 0) {
      return res.status(404).json({ error: 'No diagnostic steps found for this tag type' })
    }

    return res.json({
      tagType,
      diagnostics: diagnostics.map(d => ({ failureMode: d.FailureMode, steps: d.DiagnosticSteps })),
    })
  } catch (error) {
    console.error('Failed to fetch diagnostic steps:', error)
    return res.status(500).json({ error: 'Failed to fetch diagnostic steps' })
  }
}
