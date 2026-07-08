/**
 * POST /api/network/ring/check — re-read the ring's ACTUAL wiring and compare
 * it to the locked baseline, returning per-link/leaf/termination verdicts.
 * Reuses the capture handler for the read. Wrapped: all failures return HTTP 200
 * { ok:false, reason }.
 */
import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { getBaseline } from '@/lib/plc/network/ring-commissioning/baseline-repo'
import { compareTopology } from '@/lib/plc/network/ring-commissioning/compare'
import { POST as capturePost } from '@/app/api/network/ring/capture/route'

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const subsystemId = Number(req.body?.subsystemId ?? config.subsystemId)
    const ringName = String(req.body?.ringName ?? '')
    if (!Number.isFinite(subsystemId) || !ringName) return res.json({ ok: false, reason: 'subsystemId and ringName required' })
    const baseline = getBaseline(db, subsystemId, ringName)
    if (!baseline) return res.json({ ok: false, reason: 'No approved baseline for this ring — capture and confirm one first.' })

    // Reuse the capture handler to read the current actual. A tiny fake Response
    // captures its JSON body without going over the wire.
    let captured: { ok: boolean; ring?: { ringName: string; topology: import('@/lib/plc/network/ring-commissioning/types').RingTopology }; reason?: string } | null = null
    const fakeRes = { json: (b: unknown) => { captured = b as typeof captured } } as unknown as Response
    const captureReq = { body: { subsystemId } } as Request
    await capturePost(captureReq, fakeRes)
    if (!captured?.ok || !captured.ring) return res.json({ ok: false, reason: captured?.reason ?? 'capture failed' })

    const verdict = compareTopology(baseline.topology, captured.ring.topology)
    return res.json({ ok: true, verdict, ringName })
  } catch (e) {
    return res.json({ ok: false, reason: e instanceof Error ? e.message : 'check failed' })
  }
}
