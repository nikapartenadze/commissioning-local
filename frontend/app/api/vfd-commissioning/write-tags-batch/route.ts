import { Request, Response } from 'express'
import { getPlcClient, getPlcStatus } from '@/lib/plc-client-manager'
import {
  createTag,
  plc_tag_read,
  plc_tag_write,
  plc_tag_destroy,
  plc_tag_set_bit,
  plc_tag_set_float32,
  plc_tag_set_int16,
  plc_tag_get_uint32,
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'

interface TagWrite {
  field: string
  value: number
  dataType: 'BOOL' | 'REAL' | 'INT'
}

/** Reinterpret raw uint32 as IEEE-754 float32 (avoids ffi-rs DataType.Float crash) */
const _f32buf = new ArrayBuffer(4)
const _f32view = new DataView(_f32buf)
function uint32ToFloat(raw: number): number {
  _f32view.setUint32(0, raw, true)
  return _f32view.getFloat32(0, true)
}

/**
 * POST /api/vfd-commissioning/write-tags-batch
 *
 * PLC context (AOI Rung 11):
 *   XIC(Override_RVS) → ONS(ONS.6) → LIMIT(1,RVS,29.99) → MOVE(RVS,CommandedVelocity)
 *
 * ONS fires only on the 0→1 RISING EDGE of Override_RVS. On that one scan
 * RVS must be 1–29.99 or the LIMIT fails and the edge is consumed.
 * Rung 15 FLL(0,CMD,1) zeros everything every scan (~10ms).
 *
 * Because each plc_tag_write blocks ~7ms for the CIP round-trip, two
 * sequential writes often straddle a scan boundary. We compensate by
 * re-writing continuously and checking STS.RVS — once it matches the
 * requested value, we know a scan caught both and we stop.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, writes } = req.body as { deviceName?: string; writes?: TagWrite[] }
    if (!deviceName || !Array.isArray(writes) || writes.length === 0) {
      return res.status(400).json({ error: 'deviceName and writes[] required' })
    }

    const client = getPlcClient()
    if (!client.isConnected) {
      return res.status(503).json({ error: 'PLC not connected' })
    }

    const { connectionConfig } = getPlcStatus()
    if (!connectionConfig) {
      return res.status(503).json({ error: 'No PLC connection config available' })
    }

    // Check if this is an Override_RVS + RVS pair — if so, open a verify handle
    const rvsWrite = writes.find(w => w.field === 'RVS' && w.dataType === 'REAL')
    const hasOverride = writes.some(w => w.field === 'Override_RVS')
    const needsVerify = rvsWrite && hasOverride

    const handles: { handle: number; field: string; dataType: string; value: number; tagPath: string }[] = []
    let verifyHandle = -1

    try {
      // Phase 1: Open write handles
      for (const w of writes) {
        const isStatus = w.field === 'Speed_FPM' && w.dataType !== 'BOOL'
        const tagPath = isStatus
          ? `CBT_${deviceName}.CTRL.STS.${w.field}`
          : `CBT_${deviceName}.CTRL.CMD.${w.field}`

        const elemSize = w.dataType === 'BOOL' ? 1 : w.dataType === 'REAL' ? 4 : 2

        const handle = createTag({
          gateway: connectionConfig.ip,
          path: connectionConfig.path,
          name: tagPath,
          elemSize,
          elemCount: 1,
          timeout: connectionConfig.timeout || 5000,
        })

        if (handle < 0) {
          throw new Error(`Failed to create tag ${tagPath}: ${getStatusMessage(handle)}`)
        }

        handles.push({ handle, field: w.field, dataType: w.dataType, value: w.value, tagPath })
      }

      // Open STS.RVS handle for verify reads (if Override_RVS + RVS pair)
      if (needsVerify) {
        verifyHandle = createTag({
          gateway: connectionConfig.ip,
          path: connectionConfig.path,
          name: `CBT_${deviceName}.CTRL.STS.RVS`,
          elemSize: 4,
          elemCount: 1,
          timeout: connectionConfig.timeout || 5000,
        })
      }

      // Phase 2: Initial read (sync buffers)
      for (const h of handles) {
        const readStatus = plc_tag_read(h.handle, 5000)
        if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
          throw new Error(`Read failed for ${h.tagPath}: ${getStatusMessage(readStatus)}`)
        }
      }

      // Phase 3: Write loop — keep writing until STS.RVS matches or timeout
      const MAX_MS = 1000
      const start = Date.now()
      let iterations = 0
      let lastError: string | null = null
      let verified = false

      while (Date.now() - start < MAX_MS) {
        // Set values in buffers
        for (const h of handles) {
          if (h.dataType === 'BOOL') {
            plc_tag_set_bit(h.handle, 0, h.value ? 1 : 0)
          } else if (h.dataType === 'REAL') {
            plc_tag_set_float32(h.handle, 0, h.value)
          } else {
            plc_tag_set_int16(h.handle, 0, h.value)
          }
        }

        // Write all (blocking, short timeout)
        let ok = true
        for (const h of handles) {
          const ws = plc_tag_write(h.handle, 500)
          if (ws !== PlcTagStatus.PLCTAG_STATUS_OK) {
            ok = false
            lastError = `${h.tagPath}: ${getStatusMessage(ws)}`
          }
        }

        iterations++
        if (!ok) break

        // Check STS.RVS — did the PLC accept it?
        if (needsVerify && verifyHandle >= 0) {
          const rs = plc_tag_read(verifyHandle, 500)
          if (rs === PlcTagStatus.PLCTAG_STATUS_OK) {
            const currentRvs = uint32ToFloat(plc_tag_get_uint32(verifyHandle, 0))
            // Match within 0.1 tolerance (float rounding)
            if (Math.abs(currentRvs - rvsWrite!.value) < 0.1) {
              verified = true
              break
            }
          }
        }
      }

      const elapsed = Date.now() - start
      const success = needsVerify ? verified : !lastError
      console.log(
        `[VFD WriteTagsBatch] ${deviceName}: ${iterations} iterations, ${elapsed}ms,` +
        ` verified=${verified}, error=${lastError || 'none'}`,
      )

      return res.json({
        success,
        iterations,
        elapsedMs: elapsed,
        verified,
        writes: handles.map(h => ({ tagPath: h.tagPath, ok: success })),
        error: lastError || (!success ? 'Speed did not change within timeout' : undefined),
      })
    } finally {
      for (const h of handles) {
        try { plc_tag_destroy(h.handle) } catch { /* ignore */ }
      }
      if (verifyHandle >= 0) {
        try { plc_tag_destroy(verifyHandle) } catch { /* ignore */ }
      }
    }
  } catch (error) {
    console.error('[VFD WriteTagsBatch] Error:', error)
    return res.status(500).json({ error: `Batch write failed: ${error instanceof Error ? error.message : error}` })
  }
}
