import { Request, Response } from 'express'
import { getPlcClient, getPlcStatus } from '@/lib/plc-client-manager'
import {
  createTag,
  plc_tag_read,
  plc_tag_write,
  plc_tag_destroy,
  plc_tag_set_int8,
  plc_tag_set_int32,
  plc_tag_get_bit,
  plc_tag_get_uint8,
  plc_tag_get_uint32,
  plc_tag_get_size,
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'

/**
 * POST /api/vfd-commissioning/test-write
 *
 * Diagnostic endpoint: writes CMD.Valid_Map=1, waits for PLC scan, then reads
 * back STS.Valid_Map and STS.Check_Allowed. Returns everything so we can see
 * exactly what happened.
 */
export async function POST(req: Request, res: Response) {
  const log: string[] = []
  const L = (msg: string) => { log.push(msg); console.log(`[TestWrite] ${msg}`) }

  try {
    const { deviceName } = req.body
    if (!deviceName) {
      return res.status(400).json({ error: 'deviceName required' })
    }

    const client = getPlcClient()
    if (!client.isConnected) {
      return res.status(503).json({ error: 'PLC not connected' })
    }

    const { connectionConfig } = getPlcStatus()
    if (!connectionConfig) {
      return res.status(503).json({ error: 'No PLC connection config' })
    }

    const gateway = connectionConfig.ip
    const path = connectionConfig.path
    const timeout = connectionConfig.timeout || 5000

    // ── Step 1: Read Check_Allowed BEFORE the write ──
    L(`Reading STS.Check_Allowed for ${deviceName}...`)
    const checkAllowedResult = await readOneBit(gateway, path, timeout,
      `CBT_${deviceName}.CTRL.STS.Check_Allowed`)
    L(`  Check_Allowed = ${JSON.stringify(checkAllowedResult)}`)

    // ── Step 2: Read STS.Valid_Map BEFORE the write ──
    L(`Reading STS.Valid_Map BEFORE write...`)
    const validMapBefore = await readOneBit(gateway, path, timeout,
      `CBT_${deviceName}.CTRL.STS.Valid_Map`)
    L(`  Valid_Map (before) = ${JSON.stringify(validMapBefore)}`)

    // ── Step 3: Write CMD.Valid_Map = 1 ──
    L(`Writing CMD.Valid_Map = 1...`)
    const writeResult = await writeOneBit(gateway, path, timeout,
      `CBT_${deviceName}.CTRL.CMD.Valid_Map`, 1)
    L(`  Write result = ${JSON.stringify(writeResult)}`)

    // ── Step 4: Wait for PLC scan (200ms should be plenty) ──
    L(`Waiting 200ms for PLC scan...`)
    await new Promise(r => setTimeout(r, 200))

    // ── Step 5: Read STS.Valid_Map AFTER the write ──
    L(`Reading STS.Valid_Map AFTER write...`)
    const validMapAfter = await readOneBit(gateway, path, timeout,
      `CBT_${deviceName}.CTRL.STS.Valid_Map`)
    L(`  Valid_Map (after) = ${JSON.stringify(validMapAfter)}`)

    // ── Step 6: Read CMD.Valid_Map (should be 0 — FLL clears it) ──
    L(`Reading CMD.Valid_Map (expect 0 after FLL)...`)
    const cmdValidMap = await readOneBit(gateway, path, timeout,
      `CBT_${deviceName}.CTRL.CMD.Valid_Map`)
    L(`  CMD.Valid_Map = ${JSON.stringify(cmdValidMap)}`)

    // ── Step 7: Read all STS tags for full picture ──
    L(`Reading full STS snapshot...`)
    const stsValidHP = await readOneBit(gateway, path, timeout, `CBT_${deviceName}.CTRL.STS.Valid_HP`)
    const stsValidDir = await readOneBit(gateway, path, timeout, `CBT_${deviceName}.CTRL.STS.Valid_Direction`)
    const stsTrackBelt = await readOneBit(gateway, path, timeout, `CBT_${deviceName}.CTRL.STS.Track_Belt`)
    const stsJogging = await readOneBit(gateway, path, timeout, `CBT_${deviceName}.CTRL.STS.Jogging`)
    const stsRVS = await readOneReal(gateway, path, timeout, `CBT_${deviceName}.CTRL.STS.RVS`)
    L(`  Valid_HP=${stsValidHP.value} Valid_Direction=${stsValidDir.value} Track_Belt=${stsTrackBelt.value} Jogging=${stsJogging.value} RVS=${stsRVS.value}`)

    const summary = {
      deviceName,
      checkAllowed: checkAllowedResult,
      validMapBefore,
      writeResult,
      validMapAfter,
      cmdValidMapAfterFLL: cmdValidMap,
      stsSnapshot: {
        Valid_HP: stsValidHP.value,
        Valid_Direction: stsValidDir.value,
        Track_Belt: stsTrackBelt.value,
        Jogging: stsJogging.value,
        RVS: stsRVS.value,
      },
      conclusion: validMapAfter.value === 1
        ? 'SUCCESS: STS.Valid_Map latched!'
        : checkAllowedResult.value !== 1
          ? 'FAILED: Check_Allowed is false — drive may not be in RunMode or is ConnectionFaulted'
          : 'FAILED: Write reached PLC but STS.Valid_Map did not latch — investigate AOI',
      log,
    }

    L(`=== CONCLUSION: ${summary.conclusion} ===`)
    return res.json(summary)
  } catch (error) {
    L(`ERROR: ${error instanceof Error ? error.message : error}`)
    return res.status(500).json({ error: String(error), log })
  }
}

// ── Helpers ──

async function readOneBit(
  gateway: string, path: string, timeout: number, tagPath: string,
): Promise<{ tagPath: string; value: number | null; rawByte: number | null; error?: string }> {
  let handle = -1
  try {
    handle = createTag({ gateway, path, name: tagPath, elemSize: 1, elemCount: 1, timeout })
    if (handle < 0) {
      return { tagPath, value: null, rawByte: null, error: `createTag=${handle}: ${getStatusMessage(handle)}` }
    }
    const s = plc_tag_read(handle, 5000)
    if (s !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return { tagPath, value: null, rawByte: null, error: `read=${s}: ${getStatusMessage(s)}` }
    }
    const bit = plc_tag_get_bit(handle, 0)
    const raw = plc_tag_get_uint8(handle, 0)
    return { tagPath, value: bit, rawByte: raw }
  } catch (err) {
    return { tagPath, value: null, rawByte: null, error: String(err) }
  } finally {
    if (handle >= 0) try { plc_tag_destroy(handle) } catch { /* ignore */ }
  }
}

async function writeOneBit(
  gateway: string, path: string, timeout: number, tagPath: string, val: number,
): Promise<{ tagPath: string; success: boolean; readBeforeWrite?: number; error?: string }> {
  let handle = -1
  try {
    handle = createTag({ gateway, path, name: tagPath, elemSize: 1, elemCount: 1, timeout })
    if (handle < 0) {
      return { tagPath, success: false, error: `createTag=${handle}: ${getStatusMessage(handle)}` }
    }

    // Read first (sync buffer)
    const rs = plc_tag_read(handle, 5000)
    if (rs !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return { tagPath, success: false, error: `read before write=${rs}: ${getStatusMessage(rs)}` }
    }
    const before = plc_tag_get_uint8(handle, 0)

    // Set value using int8 (proven working approach from plc-client.ts)
    const ss = plc_tag_set_int8(handle, 0, val)
    if (ss !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return { tagPath, success: false, readBeforeWrite: before, error: `set_int8=${ss}: ${getStatusMessage(ss)}` }
    }

    // Write to PLC
    const ws = plc_tag_write(handle, 5000)
    if (ws !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return { tagPath, success: false, readBeforeWrite: before, error: `write=${ws}: ${getStatusMessage(ws)}` }
    }

    return { tagPath, success: true, readBeforeWrite: before }
  } catch (err) {
    return { tagPath, success: false, error: String(err) }
  } finally {
    if (handle >= 0) try { plc_tag_destroy(handle) } catch { /* ignore */ }
  }
}

const _f32buf = new ArrayBuffer(4)
const _f32view = new DataView(_f32buf)

async function readOneReal(
  gateway: string, path: string, timeout: number, tagPath: string,
): Promise<{ tagPath: string; value: number | null; error?: string }> {
  let handle = -1
  try {
    handle = createTag({ gateway, path, name: tagPath, elemSize: 4, elemCount: 1, timeout })
    if (handle < 0) {
      return { tagPath, value: null, error: `createTag=${handle}: ${getStatusMessage(handle)}` }
    }
    const s = plc_tag_read(handle, 5000)
    if (s !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return { tagPath, value: null, error: `read=${s}: ${getStatusMessage(s)}` }
    }
    const raw = plc_tag_get_uint32(handle, 0)
    _f32view.setUint32(0, raw, true)
    const val = _f32view.getFloat32(0, true)
    return { tagPath, value: val }
  } catch (err) {
    return { tagPath, value: null, error: String(err) }
  } finally {
    if (handle >= 0) try { plc_tag_destroy(handle) } catch { /* ignore */ }
  }
}

/**
 * GET /api/vfd-commissioning/test-write?device=NCP1_1_VFD
 *
 * Probe the CMD UDT structure: reads the whole CMD as raw bytes to determine
 * the exact byte layout and size.
 */
export async function GET(req: Request, res: Response) {
  try {
    const deviceName = (req.query.device as string) || 'NCP1_1_VFD'

    const client = getPlcClient()
    if (!client.isConnected) {
      return res.status(503).json({ error: 'PLC not connected' })
    }

    const { connectionConfig } = getPlcStatus()
    if (!connectionConfig) {
      return res.status(503).json({ error: 'No PLC connection config' })
    }

    const gateway = connectionConfig.ip
    const path = connectionConfig.path
    const timeout = connectionConfig.timeout || 5000
    const tagPath = `CBT_${deviceName}.CTRL.CMD`

    // Try multiple sizes to find the right CMD UDT buffer size
    const results: Record<number, any> = {}
    for (const trySize of [6, 8, 12]) {
      let handle = -1
      try {
        handle = createTag({ gateway, path, name: tagPath, elemSize: trySize, elemCount: 1, timeout })
        if (handle < 0) {
          results[trySize] = { error: `createTag=${handle}: ${getStatusMessage(handle)}` }
          continue
        }
        const actualSize = plc_tag_get_size(handle)
        const readStatus = plc_tag_read(handle, 5000)
        if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
          results[trySize] = { error: `read=${readStatus}: ${getStatusMessage(readStatus)}`, actualSize }
          continue
        }
        const bytes: number[] = []
        for (let i = 0; i < actualSize; i++) {
          bytes.push(plc_tag_get_uint8(handle, i))
        }
        results[trySize] = {
          actualSize,
          rawBytes: bytes,
          hex: bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
        }
      } catch (err) {
        results[trySize] = { error: String(err) }
      } finally {
        if (handle >= 0) try { plc_tag_destroy(handle) } catch { /* ignore */ }
      }
    }

    return res.json({ tagPath, probeResults: results })
  } catch (error) {
    return res.status(500).json({ error: String(error) })
  }
}
