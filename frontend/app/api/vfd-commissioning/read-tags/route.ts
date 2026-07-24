import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'
import {
  readTypedTagsForMcm,
  hasMcm,
  type TypedTagRead,
  type TypedReadResult,
  type TagDataType,
} from '@/lib/mcm-registry'

// Field names are the EXACT members of the rev-3.0 AOI_IOCT_BELT_TRACKING UDTs
// (UDT_CTRL_IOCT_BELT_TRACKING_CMD / _STS, verified against the DataType L5X
// exports). The whole CTRL.CMD/STS structure has NO RPM, NO Speed_FPM and NO
// Sync_Speed — the single speed member is `RVS` (a REAL) in both CMD and STS.
// The old Valid_MTR_HP/Valid_APF_HP split and CMD/STS Track_Belt were removed
// (→ Valid_HP, Tracking_Finished, Belt_Tracking_ON). The validation writer and
// the live vfd-wizard-reader already use these names; this reader must match or
// it reads null on a rev-3.0 controller.
const CMD_BOOL_FIELDS = [
  'Valid_Map', 'Invalidate_Map', 'Valid_HP', 'Invalidate_HP',
  'Valid_Direction', 'Bump', 'Invalidate_Direction',
  'Tracking_Finished', 'Invalidate_Tracking_Finished', 'Stop_Belt_Tracking',
  'Override_RVS', 'Run_At_30_RVS', 'Reverse_Polarity', 'Normal_Polarity',
]
const CMD_REAL_FIELDS = ['RVS']
const CMD_INT_FIELDS: string[] = []
const STS_REAL_FIELDS = ['RVS']
const STS_INT_FIELDS: string[] = []
const STS_BOOL_FIELDS = ['Check_Allowed', 'Valid_Map', 'Valid_HP', 'Valid_Direction', 'Jogging', 'Belt_Tracking_ON', 'Starting']

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
 * otherwise — both paths are now ASYNC BATCH reads (PlcClient.readTypedTags),
 * so no route-reachable sync FFI remains here.
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
      for (const f of STS_REAL_FIELDS) specs.push({ device: deviceName, group: 'sts', field: f, name: `${base}.CTRL.STS.${f}`, dataType: 'REAL' })
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
      // ONE async batch for the whole device list. The old per-tag sync
      // readTypedTag loop (~24 tags x N devices) could park the event loop for
      // multiple seconds PER TAG on a slow controller (the MCM02-freeze class);
      // readTypedTags initiates every create/read non-blocking and resolves
      // them with shared status sweeps. Same per-tag results and decoding.
      results = await client.readTypedTags(reads)
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
