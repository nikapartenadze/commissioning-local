/**
 * GET/POST /api/network/ring/baseline — read or save the operator-approved
 * golden baseline for a ring (local SQLite). POST is the "Confirm & Save" step
 * after the operator has eyeballed the captured topology against the drawing.
 * Wrapped: all failures return HTTP 200 { ok:false, reason }.
 */
import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { saveBaseline, getBaseline } from '@/lib/plc/network/ring-commissioning/baseline-repo'
import type { RingTopology } from '@/lib/plc/network/ring-commissioning/types'

export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const subsystemId = Number(req.query.subsystemId ?? config.subsystemId)
    const ringName = String(req.query.ringName ?? '')
    if (!Number.isFinite(subsystemId) || !ringName) return res.json({ ok: false, reason: 'subsystemId and ringName required' })
    return res.json({ ok: true, baseline: getBaseline(db, subsystemId, ringName) })
  } catch (e) {
    return res.json({ ok: false, reason: e instanceof Error ? e.message : 'read failed' })
  }
}

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const subsystemId = Number(req.body?.subsystemId ?? config.subsystemId)
    const ringName = String(req.body?.ringName ?? '')
    const topology = req.body?.topology as RingTopology | undefined
    const approvedBy = req.body?.approvedBy ? String(req.body.approvedBy) : null
    if (!Number.isFinite(subsystemId) || !ringName || !topology) {
      return res.json({ ok: false, reason: 'subsystemId, ringName, topology required' })
    }
    const now = new Date().toISOString()
    saveBaseline(db, { subsystemId, ringName, capturedAt: now, approvedBy, approvedAt: now, topology })
    return res.json({ ok: true })
  } catch (e) {
    return res.json({ ok: false, reason: e instanceof Error ? e.message : 'save failed' })
  }
}
