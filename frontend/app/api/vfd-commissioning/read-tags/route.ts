import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'
import {
  readTypedTagsForMcm,
  hasMcm,
  type TypedTagRead,
  type TypedReadResult,
  type TagDataType,
} from '@/lib/mcm-registry'

// Field names track the rev-3.0 AOI_IOCT_BELT_TRACKING UDTs (verified against
// the L5X): HP is a single Valid_HP (the old Valid_MTR_HP / Valid_APF_HP split
// was removed), and belt tracking is Tracking_Finished (CMD) + Belt_Tracking_ON
// (STS) — the old CMD/STS Track_Belt member no longer exists. The validation
// writer already uses these names; this reader must match or it reads null on a
// rev-3.0 controller. (RPM / Speed_FPM / Sync_Speed live in a separate speed
// AOI not covered by the belt-tracking L5X — left as-is.)
const CMD_BOOL_FIELDS = [
  'Valid_Map', 'Invalidate_Map', 'Valid_HP', 'Invalidate_HP',
  'Valid_Direction', 'Bump', 'Invalidate_Direction',
  'Tracking_Finished', 'Invalidate_Tracking_Finished', 'Stop_Belt_Tracking', 'Sync_Speed',
]
const CMD_REAL_FIELDS = ['RPM']
const CMD_INT_FIELDS = ['Speed_FPM']
const STS_INT_FIELDS = ['Speed_FPM']
const STS_BOOL_FIELDS = ['Check_Allowed', 'Valid_Map', 'Valid_HP', 'Valid_Direction', 'Jogging', 'Belt_Tracking_ON']

interface ReadSpec {
  device: string
  group: 'cmd' | 'sts'
  field: string
  name: string
  dataType: TagDataType
}

/**
 * POST /api/vfd-commissioning/read-tags  Body: { devices, subsystemId? }
 *
 * Batch reads all CTRL.CMD + CTRL.STS fields for multiple VFD devices. MCM-aware
 * when subsystemId is supplied (one gateway batch RPC); legacy singleton
 * otherwise. The per-tag FFI read now lives in PlcClient.readTypedTag.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { devices, subsystemId } = req.body
    if (!devices || !Array.isArray(devices)) {
      return res.status(400).json({ error: 'devices array required' })
    }

    // Build the flat read list (one batch for all devices/fields).
    const specs: ReadSpec[] = []
    for (const deviceName of devices) {
      const base = `CBT_${deviceName}`
      specs.push({ device: deviceName, group: 'sts', field: 'KeypadButtonF1', name: `${deviceName}:I.KeypadButtonF1`, dataType: 'BOOL' })
      for (const f of CMD_BOOL_FIELDS) specs.push({ device: deviceName, group: 'cmd', field: f, name: `${base}.CTRL.CMD.${f}`, dataType: 'BOOL' })
      for (const f of CMD_REAL_FIELDS) specs.push({ device: deviceName, group: 'cmd', field: f, name: `${base}.CTRL.CMD.${f}`, dataType: 'REAL' })
      for (const f of CMD_INT_FIELDS) specs.push({ device: deviceName, group: 'cmd', field: f, name: `${base}.CTRL.CMD.${f}`, dataType: 'INT' })
      for (const f of STS_BOOL_FIELDS) specs.push({ device: deviceName, group: 'sts', field: f, name: `${base}.CTRL.STS.${f}`, dataType: 'BOOL' })
      for (const f of STS_INT_FIELDS) specs.push({ device: deviceName, group: 'sts', field: f, name: `${base}.CTRL.STS.${f}`, dataType: 'INT' })
    }
    const reads: TypedTagRead[] = specs.map((s) => ({ name: s.name, dataType: s.dataType }))

    let results: TypedReadResult[]
    // hasMcm gate (same convention as /api/ios): a legacy single-PLC tablet
    // sends its active subsystemId too — fall through to the singleton, not 503.
    if (subsystemId !== undefined && subsystemId !== null && subsystemId !== '' && hasMcm(String(subsystemId))) {
      const batch = await readTypedTagsForMcm(String(subsystemId), reads)
      if (!batch.connected) return res.status(503).json({ error: `PLC for MCM ${subsystemId} not connected` })
      results = batch.results
    } else {
      const client = getPlcClient()
      if (!client.isConnected) return res.status(503).json({ error: 'PLC not connected' })
      results = reads.map((rd) => {
        const r = client.readTypedTag(rd.name, rd.dataType)
        return { name: rd.name, success: r.success, value: r.value, error: r.error }
      })
    }

    // Reassemble per-device cmd/sts. A failed read maps to null (matches the
    // original readPlcValue contract). KeypadButtonF1 is only set when present.
    const byName = new Map<string, TypedReadResult>()
    for (const r of results) byName.set(r.name, r)

    const result: Record<string, { cmd: Record<string, any>; sts: Record<string, any> }> = {}
    for (const deviceName of devices) result[deviceName] = { cmd: {}, sts: {} }
    for (const s of specs) {
      const r = byName.get(s.name)
      const val = r && r.success ? r.value : null
      if (s.field === 'KeypadButtonF1') {
        if (val !== null) result[s.device].sts.KeypadButtonF1 = val
        continue
      }
      result[s.device][s.group][s.field] = val
    }

    return res.json({ success: true, devices: result })
  } catch (error) {
    console.error('[VFD ReadTags] Error:', error)
    return res.status(500).json({ error: `Failed to read tags: ${error instanceof Error ? error.message : error}` })
  }
}
