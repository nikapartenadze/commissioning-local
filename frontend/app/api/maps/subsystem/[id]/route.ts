import type { Request, Response } from 'express'
import { promises as fs } from 'fs'
import path from 'path'

/**
 * GET /api/maps/subsystem/:id
 *
 * Phase 1: serves the bundled MCM09 SVG regardless of subsystemId — there's
 * only one map shipped right now, every subsystem sees it. Phase 2 will
 * look the SVG up by subsystemId in the local SubsystemMaps table and fall
 * back to a cloud fetch if missing.
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

export async function GET(_req: Request, res: Response) {
  const svg = await readBundledSvg()
  if (svg === null) {
    return res.status(404).json({ error: 'No map bundled for this subsystem' })
  }
  res.setHeader('Content-Type', 'image/svg+xml')
  res.setHeader('Cache-Control', 'no-cache')
  return res.send(svg)
}
