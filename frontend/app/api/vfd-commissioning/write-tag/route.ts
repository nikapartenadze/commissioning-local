import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'
import { writeTypedTagsForMcm } from '@/lib/mcm-registry'

/**
 * POST /api/vfd-commissioning/write-tag
 *
 * Writes a single PLC tag for VFD commissioning. MCM-aware when subsystemId is
 * supplied (central server / split — routes through the gateway); falls back to
 * the legacy singleton otherwise. The typed-write FFI now lives in
 * PlcClient.writeTypedTag (relocated verbatim), so both paths share it.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, field, value, dataType, pathScope, subsystemId } = req.body as {
      deviceName?: string
      field?: string
      value?: number
      dataType?: 'BOOL' | 'REAL' | 'INT'
      subsystemId?: string | number
      // Optional override for tag path resolution. Default behavior (no
      // pathScope) preserves the existing CBT_<dev>.CTRL.CMD/STS routing used
      // by every other wizard step. 'HMI' writes <dev>.HMI.<field> — a
      // controller-root tag without the CBT_ wrapper (mirrors the
      // KeypadButtonF1 reader convention in vfd-wizard-reader.ts).
      pathScope?: 'HMI'
    }
    console.log(`[VFD WriteTag] Request: deviceName=${deviceName}, field=${field}, value=${value}, dataType=${dataType}, pathScope=${pathScope ?? 'default'}`)

    if (!deviceName || !field) {
      return res.status(400).json({ error: 'deviceName and field required' })
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return res.status(400).json({ error: 'value (finite number) required' })
    }

    if (dataType !== 'BOOL' && dataType !== 'REAL' && dataType !== 'INT') {
      return res.status(400).json({ error: `Unsupported dataType: ${dataType}` })
    }

    // Build tag path. Default: CBT_<deviceName>.CTRL.CMD.<field> (or STS for
    // the Speed_FPM read-back special case). pathScope='HMI' targets the
    // drive's controller-level HMI struct, e.g. <deviceName>.HMI.Speed_At_30rev.
    const isStatus = field === 'Speed_FPM' && dataType !== 'BOOL'
    const tagPath =
      pathScope === 'HMI' ? `${deviceName}.HMI.${field}`
      : isStatus ? `CBT_${deviceName}.CTRL.STS.${field}`
      : `CBT_${deviceName}.CTRL.CMD.${field}`

    console.log(`[VFD WriteTag] ${tagPath} = ${value} (${dataType})${subsystemId ? ` MCM ${subsystemId}` : ' singleton'}`)

    // MCM-aware path (central server / split): route to the owning controller.
    if (subsystemId !== undefined && subsystemId !== null && subsystemId !== '') {
      const { connected, results } = await writeTypedTagsForMcm(String(subsystemId), [
        { name: tagPath, value, dataType },
      ])
      if (!connected) return res.status(503).json({ error: `PLC for MCM ${subsystemId} not connected` })
      const r = results[0]
      if (!r || !r.success) return res.status(500).json({ error: r?.error || 'Write failed' })
      return res.json({ success: true, tagPath })
    }

    // Legacy singleton (single-MCM field tablet). Same FFI, via the client method.
    const client = getPlcClient()
    if (!client.isConnected) return res.status(503).json({ error: 'PLC not connected' })
    const r = client.writeTypedTag(tagPath, value, dataType)
    if (!r.success) return res.status(500).json({ error: r.error })
    return res.json({ success: true, tagPath })
  } catch (error) {
    console.error('[VFD WriteTag] Error:', error)
    return res.status(500).json({ error: `Failed to write tag: ${error instanceof Error ? error.message : error}` })
  }
}
