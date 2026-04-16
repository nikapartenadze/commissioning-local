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

/**
 * POST /api/vfd-commissioning/write-tag
 *
 * Writes a single PLC tag for VFD commissioning.
 * Builds the full tag path from deviceName + field.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, field, value, dataType } = req.body
    if (!deviceName || !field) {
      return res.status(400).json({ error: 'deviceName and field required' })
    }

    const client = getPlcClient()
    if (!client.isConnected) {
      return res.status(503).json({ error: 'PLC not connected' })
    }

    const { connectionConfig } = getPlcStatus()
    if (!connectionConfig) {
      return res.status(503).json({ error: 'No PLC connection config available' })
    }

    // Build tag path: PLC tags are prefixed with CBT_ — e.g. CBT_NCP1_7_VFD.CTRL.CMD.Bump
    const isStatus = field === 'Speed_FPM' && dataType !== 'BOOL'
    const tagPath = isStatus
      ? `CBT_${deviceName}.CTRL.STS.${field}`
      : `CBT_${deviceName}.CTRL.CMD.${field}`

    // Determine elem_size based on data type
    let elemSize: number
    if (dataType === 'BOOL') {
      elemSize = 1
    } else if (dataType === 'REAL') {
      elemSize = 4
    } else if (dataType === 'INT') {
      elemSize = 2
    } else {
      return res.status(400).json({ error: `Unsupported dataType: ${dataType}` })
    }

    // Create a temporary tag handle for the write
    const handle = createTag({
      gateway: connectionConfig.ip,
      path: connectionConfig.path,
      name: tagPath,
      elemSize,
      elemCount: 1,
      timeout: connectionConfig.timeout || 5000,
    })

    if (handle < 0) {
      return res.status(500).json({ error: `Failed to create tag ${tagPath}: ${getStatusMessage(handle)}` })
    }

    try {
      // Read current value first (required to sync tag buffer before writing)
      const readStatus = plc_tag_read(handle, 5000)
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return res.status(500).json({ error: `Failed to read tag before write: ${getStatusMessage(readStatus)}` })
      }

      // Set the value in the tag buffer
      let setStatus: number
      if (dataType === 'BOOL') {
        setStatus = plc_tag_set_bit(handle, 0, value ? 1 : 0)
      } else if (dataType === 'REAL') {
        setStatus = plc_tag_set_float32(handle, 0, value)
      } else {
        // INT
        setStatus = plc_tag_set_int16(handle, 0, value)
      }

      if (setStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return res.status(500).json({ error: `Failed to set value: ${getStatusMessage(setStatus)}` })
      }

      // Write to PLC
      const writeStatus = plc_tag_write(handle, 5000)
      if (writeStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return res.status(500).json({ error: `Failed to write tag: ${getStatusMessage(writeStatus)}` })
      }

      return res.json({ success: true, tagPath })
    } finally {
      plc_tag_destroy(handle)
    }
  } catch (error) {
    console.error('[VFD WriteTag] Error:', error)
    return res.status(500).json({ error: `Failed to write tag: ${error instanceof Error ? error.message : error}` })
  }
}
