import { Request, Response } from 'express'
import { getPlcClient, getPlcStatus } from '@/lib/plc-client-manager'
import {
  createTag,
  plc_tag_read,
  plc_tag_write,
  plc_tag_destroy,
  plc_tag_set_int8,
  plc_tag_set_int32,
  plc_tag_set_int16,
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'

/**
 * Convert a JavaScript number (float64) to its IEEE-754 float32 bit pattern
 * stored as an int32. Avoids ffi-rs DataType.Float which crashes/corrupts.
 */
const _f32buf = new ArrayBuffer(4)
const _f32view = new DataView(_f32buf)
function floatToInt32Bits(value: number): number {
  _f32view.setFloat32(0, value, true)
  return _f32view.getInt32(0, true)
}

/**
 * POST /api/vfd-commissioning/write-tag
 *
 * Writes a single PLC tag for VFD commissioning.
 * Builds the full tag path from deviceName + field.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, field, value, dataType } = req.body
    console.log(`[VFD WriteTag] Request: deviceName=${deviceName}, field=${field}, value=${value}, dataType=${dataType}`)

    if (!deviceName || !field) {
      return res.status(400).json({ error: 'deviceName and field required' })
    }

    const client = getPlcClient()
    if (!client.isConnected) {
      console.log(`[VFD WriteTag] PLC not connected`)
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

    console.log(`[VFD WriteTag] Tag path: ${tagPath}, gateway: ${connectionConfig.ip}, path: ${connectionConfig.path}`)

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
      console.error(`[VFD WriteTag] Failed to create tag handle: ${getStatusMessage(handle)}`)
      return res.status(500).json({ error: `Failed to create tag ${tagPath}: ${getStatusMessage(handle)}` })
    }

    console.log(`[VFD WriteTag] Tag handle created: ${handle}`)

    try {
      // Read current value first (required to sync tag buffer before writing)
      const readStatus = plc_tag_read(handle, 5000)
      console.log(`[VFD WriteTag] Read status: ${readStatus} (${getStatusMessage(readStatus)})`)
      if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return res.status(500).json({ error: `Failed to read tag before write: ${getStatusMessage(readStatus)}` })
      }

      // Set the value in the tag buffer
      let setStatus: number
      if (dataType === 'BOOL') {
        // Use plc_tag_set_int8 (NOT plc_tag_set_bit) — matches proven plc-client.ts approach
        const byteVal = value ? 1 : 0
        setStatus = plc_tag_set_int8(handle, 0, byteVal)
        console.log(`[VFD WriteTag] Set int8 byte 0 to ${byteVal}, status: ${setStatus} (${getStatusMessage(setStatus)})`)
      } else if (dataType === 'REAL') {
        // Use plc_tag_set_int32 with float→int32 bit conversion.
        // plc_tag_set_float32 uses ffi-rs DataType.Float which is broken.
        const bits = floatToInt32Bits(value)
        setStatus = plc_tag_set_int32(handle, 0, bits)
        console.log(`[VFD WriteTag] Set REAL via int32 bits: value=${value}, bits=${bits}, status: ${setStatus}`)
      } else {
        // INT
        setStatus = plc_tag_set_int16(handle, 0, value)
      }

      if (setStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        console.error(`[VFD WriteTag] Set value failed: ${getStatusMessage(setStatus)}`)
        return res.status(500).json({ error: `Failed to set value: ${getStatusMessage(setStatus)}` })
      }

      // Write to PLC
      const writeStatus = plc_tag_write(handle, 5000)
      console.log(`[VFD WriteTag] Write status: ${writeStatus} (${getStatusMessage(writeStatus)})`)
      if (writeStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
        return res.status(500).json({ error: `Failed to write tag: ${getStatusMessage(writeStatus)}` })
      }

      console.log(`[VFD WriteTag] SUCCESS: ${tagPath} = ${value}`)
      return res.json({ success: true, tagPath })
    } finally {
      plc_tag_destroy(handle)
    }
  } catch (error) {
    console.error('[VFD WriteTag] Error:', error)
    return res.status(500).json({ error: `Failed to write tag: ${error instanceof Error ? error.message : error}` })
  }
}
