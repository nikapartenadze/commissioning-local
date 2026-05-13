import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * GET /api/mcm-diagram/:mcm
 *
 * Returns the cached SCADA layout SVG for the requested MCM. Empty when no
 * diagram has been pulled yet — the caller (UI component) decides whether
 * to trigger a pull or show "no diagram yet".
 *
 * Response: { success: true, mcm, svgContent | null, serverUploadedAt, fetchedAt }
 */

const getStmt = db.prepare(`
  SELECT McmName, SvgContent, ServerUploadedAt, FetchedAt
  FROM McmDiagrams
  WHERE McmName = ?
`)

export async function GET(req: Request, res: Response) {
  try {
    const mcm = req.params.mcm
    if (!mcm || typeof mcm !== 'string') {
      return res.status(400).json({ success: false, error: 'mcm path param required' })
    }

    const row = getStmt.get(mcm) as
      | { McmName: string; SvgContent: string; ServerUploadedAt: string | null; FetchedAt: string }
      | undefined

    if (!row) {
      return res.json({
        success: true,
        mcm,
        svgContent: null,
        serverUploadedAt: null,
        fetchedAt: null,
      })
    }

    return res.json({
      success: true,
      mcm: row.McmName,
      svgContent: row.SvgContent,
      serverUploadedAt: row.ServerUploadedAt,
      fetchedAt: row.FetchedAt,
    })
  } catch (error) {
    console.error('[McmDiagram] Error:', error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load MCM diagram',
    })
  }
}
