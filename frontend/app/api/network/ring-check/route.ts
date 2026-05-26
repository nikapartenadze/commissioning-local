import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { DEFAULT_RING_SNMP, DEFAULT_RING_MODBUS } from '@/lib/network/ring/types'
import { scanRing, DpmTarget, ScanOptions } from '@/lib/network/ring/scan'
import { buildReport } from '@/lib/network/ring/compare'
import { getBaseline, recordCheckRun } from '@/lib/network/ring/baseline-store'

/**
 * POST /api/network/ring-check
 * Body: { ringId: number, runBy?: string }
 *
 * Runs a live read-only SNMP scan of every switch in the ring, compares it to
 * the saved baseline (if any), records the run for audit, and returns both the
 * pass/fail report and the raw scan (the latter feeds the "Save as baseline"
 * step on a first run).
 */
export async function POST(req: Request, res: Response) {
  const ringId = Number(req.body?.ringId)
  if (!Number.isFinite(ringId)) {
    return res.status(400).json({ success: false, error: 'ringId is required' })
  }

  const ring = db.prepare('SELECT * FROM NetworkRings WHERE id = ?').get(ringId) as any
  if (!ring) {
    return res.status(404).json({ success: false, error: 'Ring not found' })
  }
  const nodes = db
    .prepare('SELECT * FROM NetworkNodes WHERE RingId = ? ORDER BY Position')
    .all(ringId) as any[]

  const cfg = await configService.getConfig()
  const ringCfg = cfg.ring ?? {}
  const ipOverrides = ringCfg.ipOverrides ?? {}

  // Scan the DPM Moxa switches. The MCM closes the ring loop but is a Rockwell
  // module (not normally SNMP-managed), so it's only scanned when opted in.
  const rawTargets: DpmTarget[] = [
    ...(ringCfg.includeMcm && ring.McmIp
      ? [{ dpmName: ring.McmName, ip: ipOverrides[ring.McmName] || ring.McmIp }]
      : []),
    ...nodes.map((n) => ({ dpmName: n.Name, ip: ipOverrides[n.Name] || n.IpAddress })),
  ]
  const targets = rawTargets.filter((t) => !!t.ip)
  if (targets.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No switch IP addresses available for this ring. Pull/seed network data with DPM IPs first.',
    })
  }

  const options: ScanOptions = {
    snmp: {
      community: ringCfg.snmpCommunity ?? DEFAULT_RING_SNMP.community,
      port: ringCfg.snmpPort ?? DEFAULT_RING_SNMP.port,
      timeoutMs: ringCfg.snmpTimeoutMs ?? DEFAULT_RING_SNMP.timeoutMs,
      retries: ringCfg.snmpRetries ?? DEFAULT_RING_SNMP.retries,
    },
    ringOids: ringCfg.moxaOids,
    modbus: ringCfg.modbus?.enabled
      ? {
          enabled: true,
          port: ringCfg.modbus.port ?? DEFAULT_RING_MODBUS.port,
          unitId: ringCfg.modbus.unitId ?? DEFAULT_RING_MODBUS.unitId,
          timeoutMs:
            ringCfg.modbus.timeoutMs ?? ringCfg.snmpTimeoutMs ?? DEFAULT_RING_MODBUS.timeoutMs,
        }
      : undefined,
  }

  const scan = await scanRing({ ringId, ringName: ring.Name, targets, options })
  const baseline = getBaseline(ringId)
  const report = buildReport(scan, baseline)

  // Best-effort audit record; never fail the request over it.
  try {
    recordCheckRun(report, typeof req.body?.runBy === 'string' ? req.body.runBy : undefined)
  } catch (err) {
    console.warn('[ring-check] failed to record run:', err)
  }

  return res.json({ success: true, report, scan })
}
