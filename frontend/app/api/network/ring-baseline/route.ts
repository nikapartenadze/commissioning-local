import { Request, Response } from 'express'
import type { RingScanResult } from '@/lib/network/ring/types'
import { buildBaselineFromScan } from '@/lib/network/ring/compare'
import { getBaseline, saveBaseline, deleteBaseline } from '@/lib/network/ring/baseline-store'

/**
 * GET /api/network/ring-baseline?ringId=N — return the saved baseline, or null.
 */
export async function GET(req: Request, res: Response) {
  const ringId = Number(req.query.ringId)
  if (!Number.isFinite(ringId)) {
    return res.status(400).json({ success: false, error: 'ringId is required' })
  }
  return res.json({ success: true, baseline: getBaseline(ringId) })
}

/**
 * PUT /api/network/ring-baseline
 * Body: { ringId: number, scan: RingScanResult, savedBy?: string }
 *
 * Saves the reviewed scan as the expected baseline (the "confirm against the
 * drawing, then save" step of the hybrid workflow).
 */
export async function PUT(req: Request, res: Response) {
  const ringId = Number(req.body?.ringId)
  const scan = req.body?.scan as RingScanResult | undefined
  if (!Number.isFinite(ringId) || !scan || !Array.isArray(scan.dpms)) {
    return res.status(400).json({ success: false, error: 'ringId and a valid scan are required' })
  }
  const savedBy = typeof req.body?.savedBy === 'string' ? req.body.savedBy : undefined
  const baseline = buildBaselineFromScan({ ...scan, ringId }, savedBy)
  saveBaseline(baseline)
  return res.json({ success: true, baseline })
}

/**
 * DELETE /api/network/ring-baseline?ringId=N — clear the baseline (e.g. before
 * re-learning after a legitimate rewire).
 */
export async function DELETE(req: Request, res: Response) {
  const ringId = Number(req.query.ringId)
  if (!Number.isFinite(ringId)) {
    return res.status(400).json({ success: false, error: 'ringId is required' })
  }
  deleteBaseline(ringId)
  return res.json({ success: true })
}
