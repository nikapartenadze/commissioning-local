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
 * Writes multiple PLC tags for one VFD device "back to back" — opens all handles,
 * sets all values in their buffers, then writes them in rapid succession.
 *
 * This gives the PLC the best chance of catching the writes on the same scan cycle.
 * It is NOT a true atomic write (Ethernet/IP doesn't support that for arbitrary tags),
 * but the writes complete within milliseconds of each other.
 *
 * Use case: Override_RVS=1 + RVS=value must be set together so the PLC accepts the new RPM.
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
      // Phase 1: Open all handles + read current values to populate buffers
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

      // Phase 2: Read all (sync buffers)
      for (const h of handles) {
        const readStatus = plc_tag_read(h.handle, 5000)
        if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
          throw new Error(`Read failed for ${h.tagPath}: ${getStatusMessage(readStatus)}`)
        }
      }

      // Phase 3: Set all values in buffers
      for (const h of handles) {
        let setStatus: number
        if (h.dataType === 'BOOL') {
          setStatus = plc_tag_set_bit(h.handle, 0, h.value ? 1 : 0)
        } else if (h.dataType === 'REAL') {
          setStatus = plc_tag_set_float32(h.handle, 0, h.value)
        } else {
          setStatus = plc_tag_set_int16(h.handle, 0, h.value)
        }
        if (setStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
          throw new Error(`Set value failed for ${h.tagPath}: ${getStatusMessage(setStatus)}`)
        }
      }

      // Phase 4: Write all back-to-back (PLC scans should catch them together)
      const writeResults: { tagPath: string; ok: boolean; error?: string }[] = []
      for (const h of handles) {
        const writeStatus = plc_tag_write(h.handle, 5000)
        writeResults.push({
          tagPath: h.tagPath,
          ok: writeStatus === PlcTagStatus.PLCTAG_STATUS_OK,
          error: writeStatus !== PlcTagStatus.PLCTAG_STATUS_OK ? getStatusMessage(writeStatus) : undefined,
        })
      }

      const allOk = writeResults.every(r => r.ok)
      return res.json({ success: allOk, writes: writeResults })
    } finally {
      // Phase 5: Destroy all handles
      for (const h of handles) {
        try { plc_tag_destroy(h.handle) } catch { /* ignore */ }
      }
    }
  } catch (error) {
    console.error('[VFD WriteTagsBatch] Error:', error)
    return res.status(500).json({ error: `Batch write failed: ${error instanceof Error ? error.message : error}` })
  }
}
