/**
 * POST /api/network/ring/capture — on-demand read of a ring's ACTUAL wiring.
 *
 * Reads (from one point): LLDP uplinks + FDB leaf placement over SNMP, plus the
 * existing DLR ring verdict when a supervisor is present. On-demand only, wholly
 * wrapped: every failure returns HTTP 200 { ok:false, reason } so it can never
 * crash or lag the core tool. Returns the captured topology WITHOUT saving it.
 */
import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { resolveSwitchTargets } from '@/lib/plc/network/ring-commissioning/resolve-targets'
import { captureRing } from '@/lib/plc/network/ring-commissioning/capture'
import { readDlrStatus, ringVerdict, deriveDlrPath } from '@/lib/plc/network/dlr'
import type { PortTermination, RingState } from '@/lib/plc/network/ring-commissioning/types'
import type { SnmpCreds } from '@/lib/plc/network/ring-commissioning/snmp/client'

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const snmp = config.snmp
    if (!snmp?.enabled) {
      return res.json({ ok: false, reason: 'SNMP is not configured for this tool (config.snmp.enabled=false). Ring Commissioning is off.' })
    }
    const subsystemId = Number(req.body?.subsystemId ?? config.subsystemId)
    if (!Number.isFinite(subsystemId)) return res.json({ ok: false, reason: 'Subsystem not resolved.' })

    const creds: SnmpCreds = {
      version: snmp.version, community: snmp.community, port: snmp.port,
      timeoutMs: snmp.timeoutMs, retries: snmp.retries,
    }
    const rings = resolveSwitchTargets(db, subsystemId)
    if (rings.length === 0) {
      return res.json({ ok: false, reason: 'No ring/switches known for this subsystem — pull network topology first.' })
    }

    // First ring per capture call. DLR ring read (existing, proven) when a
    // supervisor path is resolvable and a PLC IP is configured.
    const ring = rings[0]
    let dlrRing: RingState | null = null
    const dlrPath = config.dlrSupervisorPath || deriveDlrPath(ring.switches.map(s => s.name))
    if (dlrPath && config.ip) {
      const dlr = await readDlrStatus(config.ip, dlrPath).catch(() => null)
      if (dlr) {
        const v = ringVerdict(dlr)
        dlrRing = {
          closed: v.state === 'healthy',
          source: 'dlr',
          reason: v.reason,
          breakBetween: v.lastActiveNode1 && v.lastActiveNode2 ? [v.lastActiveNode1, v.lastActiveNode2] : undefined,
        }
      }
    }

    const result = await captureRing(ring.switches, creds, {
      resolveChassis: ring.resolveChassis,
      resolveMac: ring.resolveMac,
      portIfIndex: () => new Map(),
      dlrRing,
      // 0xF6 terminations are surfaced live in the Diagnostics view; folding
      // them into the capture is a follow-up. Empty is safe — compare handles it.
      terminations: (): PortTermination[] => [],
    })
    if (!result.ok) return res.json({ ok: false, reason: result.reason })
    return res.json({ ok: true, ring: { ringName: ring.ringName, topology: result.topology } })
  } catch (e) {
    return res.json({ ok: false, reason: e instanceof Error ? e.message : 'capture failed' })
  }
}
