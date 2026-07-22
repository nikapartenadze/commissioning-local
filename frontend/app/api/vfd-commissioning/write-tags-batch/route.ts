import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'
import { hammerWriteTagsForMcm, hasMcm, type HammerWrite } from '@/lib/mcm-registry'
import { judgeBatch } from '../_gate/belt-tracking-gate'
import { lookupBeltTrackedState } from '../_gate/belt-tracked-lookup'

type TagWrite = HammerWrite

/**
 * POST /api/vfd-commissioning/write-tags-batch
 *
 * Writes multiple CMD tags in one call. Used for Override_RVS + RVS pair
 * where both values must land in the same PLC scan.
 *
 * PLC context:
 *   - Rung 11: XIC(Override_RVS) ONS → LIMIT(1,RVS,29.99) → MOVE(RVS,CommandedVelocity)
 *   - Rung 15: FLL(0,CMD,1) — zeros the entire CMD every scan (~10ms)
 *
 * Two separate CIP writes (~7ms each) can straddle a scan boundary,
 * causing the ONS to fire while RVS is still 0 — wasting the edge.
 * We compensate by continuously re-writing both values for ~1 second,
 * giving the PLC 50-100 chances to catch both in the same scan.
 *
 * BELT-TRACKING GATE. This is the OTHER write path, and the one the wizard's
 * polarity step actually uses for the Reverse_Polarity / Normal_Polarity pair
 * — the pair a coordinator re-locked four belts with on 2026-07-22. It gets
 * the same server-side refusal as write-tag, all-or-nothing across the batch:
 * these calls exist to land a PAIR in one scan, and half a pair is not a safer
 * outcome than none of it. See ../_gate/belt-tracking-gate.ts.
 *
 * Note the hammer loop re-writes for ~1 second, so an ungated post-gate field
 * here is 50-100 chances to latch, not one.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, writes, subsystemId } = req.body as {
      deviceName?: string
      writes?: TagWrite[]
      subsystemId?: string | number
    }
    if (!deviceName || !Array.isArray(writes) || writes.length === 0) {
      return res.status(400).json({ error: 'deviceName and writes[] required' })
    }

    // ── BELT-TRACKING GATE ────────────────────────────────────────────────
    // One lookup for the whole batch; the first post-gate field on an
    // untracked belt refuses everything. Runs before either branch dispatches.
    const refusal = judgeBatch(
      writes.map(w => String(w?.field ?? '')),
      lookupBeltTrackedState(deviceName, subsystemId),
    )
    if (refusal) {
      console.warn(
        `[VFD WriteTagsBatch] REFUSED ${deviceName} batch [${writes.map(w => w?.field).join(', ')}] ` +
        `on ${refusal.field} (${refusal.code}): ${refusal.message}`,
      )
      return res.status(409).json({
        // `error` keeps existing clients (which read res.ok + .error) working.
        error: refusal.message,
        code: refusal.code,
        field: refusal.field,
        deviceName,
        message: refusal.message,
      })
    }

    // The timing-critical 1s hammer loop runs where the connection is: in-process
    // (embedded) or inside the gateway (remote). PlcClient.hammerWriteTags holds
    // the verbatim loop.
    let result
    // hasMcm gate (same convention as /api/ios): a legacy single-PLC tablet
    // sends its active subsystemId too — fall through to the singleton, not 503.
    if (subsystemId !== undefined && subsystemId !== null && subsystemId !== '' && hasMcm(String(subsystemId))) {
      const r = await hammerWriteTagsForMcm(String(subsystemId), deviceName, writes)
      if (!r.connected) return res.status(503).json({ error: `PLC for MCM ${subsystemId} not connected` })
      result = r
    } else {
      const client = getPlcClient()
      if (!client.isConnected) return res.status(503).json({ error: 'PLC not connected' })
      result = client.hammerWriteTags(deviceName, writes)
    }

    console.log(`[VFD WriteTagsBatch] ${deviceName}: ${result.iterations} writes, success=${result.success}`)
    return res.json({ success: result.success, writes: result.writes, error: result.error || undefined })
  } catch (error) {
    console.error('[VFD WriteTagsBatch] Error:', error)
    return res.status(500).json({ error: `Batch write failed: ${error instanceof Error ? error.message : error}` })
  }
}
