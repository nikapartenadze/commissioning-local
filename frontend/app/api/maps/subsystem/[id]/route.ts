import type { Request, Response } from 'express'
import { promises as fs } from 'fs'
import path from 'path'
import { db } from '@/lib/db-sqlite'

/**
 * GET /api/maps/subsystem/:id
 *
 * Resolves the SCADA SVG for a given subsystem in this priority order:
 *   1) Local McmDiagrams cache, keyed by Subsystems.Name (the MCM name).
 *      Populated by POST /api/cloud/pull-mcm-diagram from cloud Postgres
 *      (which was in turn seeded from the PLC_Generation Convex
 *      snapshot — see commissioning-cloud/scripts/upload-cdw5-svgs.mjs).
 *   2) The bundled MCM09 file as a dev fallback so the original Phase 1
 *      flow keeps working even when nothing has been pulled yet.
 *
 * Path resolution: Vite copies `public/*` into `dist/` at build time, and
 * `process.cwd()` differs between `npm run dev` (frontend/) and the
 * production runtime (dist-server/, with dist/ as a sibling). Try both.
 */
const SVG_CANDIDATES = [
  path.join(process.cwd(), 'public', 'maps', 'MCM09_Detailed_View.svg'), // dev
  path.join(process.cwd(), 'dist', 'maps', 'MCM09_Detailed_View.svg'),   // prod (after vite build)
]

export async function readBundledSvg(): Promise<string | null> {
  for (const p of SVG_CANDIDATES) {
    try {
      return await fs.readFile(p, 'utf-8')
    } catch {
      // try next candidate
    }
  }
  return null
}

interface SubsystemRow { Name: string | null }
interface DiagramRow { SvgContent: string }

export async function GET(req: Request, res: Response) {
  const id = parseInt(String(req.params.id), 10)
  if (Number.isInteger(id) && id > 0) {
    const sub = db.prepare(`SELECT Name FROM Subsystems WHERE id = ?`).get(id) as SubsystemRow | undefined
    if (sub?.Name) {
      const row = db.prepare(`SELECT SvgContent FROM McmDiagrams WHERE McmName = ?`).get(sub.Name) as DiagramRow | undefined
      if (row?.SvgContent) {
        res.setHeader('Content-Type', 'image/svg+xml')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('X-Map-Source', 'mcm-diagrams-cache')
        return res.send(row.SvgContent)
      }
    }
  }

  // Bundled-file fallback — preserves the Phase 1 demo working out of the box.
  const svg = await readBundledSvg()
  if (svg === null) {
    return res.status(404).json({ error: 'No map available for this subsystem' })
  }
  res.setHeader('Content-Type', 'image/svg+xml')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Map-Source', 'bundled-fallback')
  return res.send(svg)
}
