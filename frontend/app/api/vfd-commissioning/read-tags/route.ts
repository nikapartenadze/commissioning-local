import { Request, Response } from 'express'
import { getPlcClient, getPlcStatus } from '@/lib/plc-client-manager'
import {
  createTag,
  plc_tag_read,
  plc_tag_destroy,
  plc_tag_get_bit,
  plc_tag_get_float32,
  plc_tag_get_int16,
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'

const CMD_BOOL_FIELDS = [
  'Valid_Map', 'Invalidate_Map', 'Valid_MTR_HP', 'Valid_APF_HP',
  'Invalidate_HP', 'Valid_Direction', 'Bump', 'Invalidate_Direction',
  'Track_Belt', 'Stop_Belt_Tracking', 'Sync_Speed',
]
const CMD_REAL_FIELDS = ['RPM']
const CMD_INT_FIELDS = ['Speed_FPM']
const STS_INT_FIELDS = ['Speed_FPM']
const STS_BOOL_FIELDS = ['Check_Allowed', 'Valid_Map', 'Valid_HP', 'Valid_Direction', 'Jogging', 'Track_Belt']

/**
 * Read a single PLC tag value using a temporary handle.
 * Returns the read value or null on failure.
 */
function readPlcValue(
  gateway: string,
  path: string,
  tagPath: string,
  dataType: 'BOOL' | 'REAL' | 'INT',
  timeout: number,
): number | boolean | null {
  const elemSize = dataType === 'BOOL' ? 1 : dataType === 'INT' ? 2 : 4

  const handle = createTag({
    gateway,
    path,
    name: tagPath,
    elemSize,
    elemCount: 1,
    timeout,
  })

  if (handle < 0) return null

  try {
    const readStatus = plc_tag_read(handle, 5000)
    if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) return null

    if (dataType === 'BOOL') {
      const val = plc_tag_get_bit(handle, 0)
      return val === 1
    } else if (dataType === 'REAL') {
      return plc_tag_get_float32(handle, 0)
    } else {
      return plc_tag_get_int16(handle, 0)
    }
  } catch {
    return null
  } finally {
    try { plc_tag_destroy(handle) } catch { /* ignore */ }
  }
}

/**
 * POST /api/vfd-commissioning/read-tags
 *
 * Batch reads all CTRL.CMD + CTRL.STS fields for multiple VFD devices.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { devices } = req.body
    if (!devices || !Array.isArray(devices)) {
      return res.status(400).json({ error: 'devices array required' })
    }

    const client = getPlcClient()
    if (!client.isConnected) {
      return res.status(503).json({ error: 'PLC not connected' })
    }

    const { connectionConfig } = getPlcStatus()
    if (!connectionConfig) {
      return res.status(503).json({ error: 'No PLC connection config available' })
    }

    const { ip: gateway, path, timeout = 5000 } = connectionConfig

    const result: Record<string, any> = {}

    for (const deviceName of devices) {
      const cmd: Record<string, any> = {}
      const sts: Record<string, any> = {}

      // Read CMD BOOL fields
      for (const field of CMD_BOOL_FIELDS) {
        cmd[field] = readPlcValue(gateway, path, `${deviceName}.CTRL.CMD.${field}`, 'BOOL', timeout)
      }
      // Read CMD REAL fields
      for (const field of CMD_REAL_FIELDS) {
        cmd[field] = readPlcValue(gateway, path, `${deviceName}.CTRL.CMD.${field}`, 'REAL', timeout)
      }
      // Read CMD INT fields
      for (const field of CMD_INT_FIELDS) {
        cmd[field] = readPlcValue(gateway, path, `${deviceName}.CTRL.CMD.${field}`, 'INT', timeout)
      }
      // Read STS BOOL fields
      for (const field of STS_BOOL_FIELDS) {
        sts[field] = readPlcValue(gateway, path, `${deviceName}.CTRL.STS.${field}`, 'BOOL', timeout)
      }
      // Read STS INT fields
      for (const field of STS_INT_FIELDS) {
        sts[field] = readPlcValue(gateway, path, `${deviceName}.CTRL.STS.${field}`, 'INT', timeout)
      }

      result[deviceName] = { cmd, sts }
    }

    return res.json({ success: true, devices: result })
  } catch (error) {
    console.error('[VFD ReadTags] Error:', error)
    return res.status(500).json({ error: `Failed to read tags: ${error instanceof Error ? error.message : error}` })
  }
}
