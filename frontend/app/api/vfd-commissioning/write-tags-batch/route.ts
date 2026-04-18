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
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'

interface TagWrite {
  field: string
  value: number
  dataType: 'BOOL' | 'REAL' | 'INT'
}

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

    const handles: { handle: number; field: string; dataType: string; value: number; tagPath: string }[] = []

    try {
      // Open write handles
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

      // Initial read (sync buffers)
      for (const h of handles) {
        const readStatus = plc_tag_read(h.handle, 5000)
        if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
          throw new Error(`Read failed for ${h.tagPath}: ${getStatusMessage(readStatus)}`)
        }
      }

      // Write continuously for ~1s — gives PLC many scan cycles to catch
      // both values together. No verification needed, the wizard reader
      // shows live STS.RVS in the UI.
      const WRITE_MS = 1000
      const start = Date.now()
      let iterations = 0
      let lastError: string | null = null

      while (Date.now() - start < WRITE_MS) {
        for (const h of handles) {
          if (h.dataType === 'BOOL') {
            plc_tag_set_bit(h.handle, 0, h.value ? 1 : 0)
          } else if (h.dataType === 'REAL') {
            plc_tag_set_float32(h.handle, 0, h.value)
          } else {
            plc_tag_set_int16(h.handle, 0, h.value)
          }
        }

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
      }

      const success = !lastError
      console.log(`[VFD WriteTagsBatch] ${deviceName}: ${iterations} writes in ${Date.now() - start}ms, success=${success}`)

      return res.json({
        success,
        writes: handles.map(h => ({ tagPath: h.tagPath, ok: success })),
        error: lastError || undefined,
      })
    } finally {
      for (const h of handles) {
        try { plc_tag_destroy(h.handle) } catch { /* ignore */ }
      }
    }
  } catch (error) {
    console.error('[VFD WriteTagsBatch] Error:', error)
    return res.status(500).json({ error: `Batch write failed: ${error instanceof Error ? error.message : error}` })
  }
}
