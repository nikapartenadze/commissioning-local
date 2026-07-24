import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'
import { writeTypedTagsForMcm, hasMcm } from '@/lib/mcm-registry'
import { judgeWrite } from '../_gate/belt-tracking-gate'
import { lookupBeltTrackedState } from '../_gate/belt-tracked-lookup'

/**
 * POST /api/vfd-commissioning/write-tag
 *
 * Writes a single PLC tag for VFD commissioning. MCM-aware when subsystemId is
 * supplied (central server / split — routes through the gateway); falls back to
 * the legacy singleton otherwise. The typed-write FFI now lives in
 * PlcClient.writeTypedTag (relocated verbatim), so both paths share it.
 *
 * BELT-TRACKING GATE. This route validated presence and type only, which meant
 * any client could latch CMD.Tracking_Finished on any device by name — and
 * that latch takes belt direction away from the mechanics' keypad (AOI rung 3).
 * The wizard now falls back when a belt is untracked (9d9a826), but a UI flag
 * only constrains the one client running the new build. The refusal is
 * enforced HERE, on the box that owns the PLC connection, BEFORE the tag path
 * is built — see ../_gate/belt-tracking-gate.ts for the field lists and the
 * ladder ground truth behind them. Both the MCM-routed and legacy-singleton
 * branches sit behind it.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, field, value, dataType, pathScope, subsystemId } = req.body as {
      deviceName?: string
      field?: string
      value?: number
      dataType?: 'BOOL' | 'REAL' | 'INT' | 'DINT'
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

    if (dataType !== 'BOOL' && dataType !== 'REAL' && dataType !== 'INT' && dataType !== 'DINT') {
      return res.status(400).json({ error: `Unsupported dataType: ${dataType}` })
    }

    // ── BELT-TRACKING GATE ────────────────────────────────────────────────
    // Refuse belt-authority writes on a belt whose 'Belt Tracked' L2 cell is
    // empty. Evaluated before ANY tag path is built, so a refusal cannot reach
    // the controller by either branch below. Retraction fields, pre-gate
    // fields, and sheets with no 'Belt Tracked' column are unaffected.
    const gate = judgeWrite(field, lookupBeltTrackedState(deviceName, subsystemId))
    if (!gate.allowed) {
      console.warn(
        `[VFD WriteTag] REFUSED ${deviceName}.${field} (${gate.code}): ${gate.message}`,
      )
      return res.status(409).json({
        // `error` keeps existing clients (which read res.ok + .error) working.
        error: gate.message,
        code: gate.code,
        field,
        deviceName,
        message: gate.message,
      })
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
    // hasMcm gate (same convention as /api/ios): a legacy single-PLC tablet
    // sends its active subsystemId too, but has no registry entry for it —
    // it must fall through to the singleton below, not 503.
    if (subsystemId !== undefined && subsystemId !== null && subsystemId !== '' && hasMcm(String(subsystemId))) {
      const { connected, results } = await writeTypedTagsForMcm(String(subsystemId), [
        { name: tagPath, value, dataType },
      ])
      if (!connected) return res.status(503).json({ error: `PLC for MCM ${subsystemId} not connected` })
      const r = results[0]
      if (!r || !r.success) return res.status(500).json({ error: r?.error || 'Write failed' })
      return res.json({ success: true, tagPath })
    }

    // Legacy singleton (single-MCM field tablet). Same FFI semantics, via the
    // client method — now async/non-blocking (writeTypedTag no longer parks
    // the event loop for the CIP round-trips).
    const client = getPlcClient()
    if (!client.isConnected) return res.status(503).json({ error: 'PLC not connected' })
    const r = await client.writeTypedTag(tagPath, value, dataType)
    if (!r.success) return res.status(500).json({ error: r.error })
    return res.json({ success: true, tagPath })
  } catch (error) {
    console.error('[VFD WriteTag] Error:', error)
    return res.status(500).json({ error: `Failed to write tag: ${error instanceof Error ? error.message : error}` })
  }
}
