import type { Request, Response } from 'express'
import { deriveSystemRunning } from '@/lib/guided/system-running'

/**
 * GET /api/guided/system-status
 *
 * Tiny live-status endpoint the Guided-Mode runner polls (~5 s) for the two
 * committee gates that must react in real time, mid-task:
 *
 *   - D5: DPM ring health — guided mode cannot function when the ring is not
 *     nominal, and that must be EXTREMELY obvious to the tester.
 *   - D4: system started / conveyors running — functional steps are disabled
 *     with a "Start the system" prompt while stopped.
 *
 * Both reads are best-effort against in-memory caches (no PLC round-trip, no
 * DB) so polling is essentially free and never disturbs the tag reader.
 */
export async function GET(req: Request, res: Response) {
  let ring: { state: string; reason?: string; lastActiveNode1?: string | null; lastActiveNode2?: string | null } | null = null
  let systemRunning: boolean | null = null

  // Per-MCM ring gate (central/multi-MCM server). The legacy singleton poller
  // never runs in PLC_MODE=remote / multi-MCM embedded, so getLatestRingStatus()
  // returns null for every MCM and D5 stays grey fleet-wide. When the caller
  // names a registry MCM, read THAT MCM's poller; otherwise (single-MCM field
  // tablet, no subsystemId) fall back to the singleton.
  const sidRaw = req.query.subsystemId
  const sid = sidRaw != null && sidRaw !== '' ? String(sidRaw) : null

  try {
    // Lazy require so non-PLC contexts (tests, tools) never pull the FFI stack.
    const mgr = require('@/lib/plc-client-manager') as typeof import('@/lib/plc-client-manager')
    let r: ReturnType<typeof mgr.getLatestRingStatus> = null
    if (sid) {
      const registry = require('@/lib/mcm-registry') as typeof import('@/lib/mcm-registry')
      if (registry.hasMcm(sid)) {
        r = registry.getRingStatusForMcm(sid)
      } else {
        r = mgr.getLatestRingStatus()
      }
    } else {
      r = mgr.getLatestRingStatus()
    }
    if (r) {
      ring = {
        state: r.state,
        reason: r.reason,
        lastActiveNode1: r.lastActiveNode1 ?? null,
        lastActiveNode2: r.lastActiveNode2 ?? null,
      }
    }
  } catch {
    /* legacy singleton stack unavailable — ring stays null */
  }
  try {
    // Mode-aware union (Phase 1.1): registry MCMs (embedded or gateway cache
    // in PLC_MODE=remote), singleton fallback on tablets.
    const { getLiveTagsUnion } = require('@/lib/plc-live-tags') as typeof import('@/lib/plc-live-tags')
    systemRunning = deriveSystemRunning(getLiveTagsUnion())
  } catch {
    /* no PLC stack available — stays unknown */
  }
  return res.json({ ring, systemRunning })
}
