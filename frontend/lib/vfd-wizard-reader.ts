/**
 * VFD Wizard Reader — small, focused tag reader for one VFD's 8 STS+keypad tags.
 *
 * Mirrors the architecture of TagReaderService but scoped to a single device.
 * Uses non-blocking handle creation (timeout=0 + waitForStatus) and an async
 * polling loop. Broadcasts value changes over the existing WebSocket.
 *
 * Lifecycle:
 *   - openWizardReader(deviceName): creates handles + starts polling loop
 *   - closeWizardReader(deviceName): stops loop + destroys handles
 *
 * Tag creation failures are non-fatal — failed tags are retried in the background
 * every few seconds while the reader is alive. The broadcast ALWAYS includes
 * every tag key so the client can see which ones are connected vs missing.
 */

import {
  createTag,
  plc_tag_destroy,
  plc_tag_get_bit,
  plc_tag_get_int16,
  plc_tag_get_uint32,
  readTagAsync,
  waitForStatus,
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'

/**
 * Read a REAL (float32) from a tag by reading raw uint32 bytes and
 * reinterpreting as float32. This avoids the ffi-rs bug where
 * DataType.Float returns "JsNumber can only be double type".
 */
const _f32buf = new ArrayBuffer(4)
const _f32view = new DataView(_f32buf)
function readFloat32FromTag(handle: number, offset: number): number {
  const raw = plc_tag_get_uint32(handle, offset)
  _f32view.setUint32(0, raw, true) // little-endian (Logix native byte order)
  return _f32view.getFloat32(0, true)
}

// ── Types ──────────────────────────────────────────────────────────

interface TagDef {
  key: string
  tagPath: string
  dataType: 'BOOL' | 'INT' | 'REAL'
  elemSize: number
}

interface ReaderTagState {
  def: TagDef
  handle: number       // -1 if creation failed (will retry)
  value: number
  hasValue: boolean
  lastErrorMs: number  // last time creation/read failed (for retry throttling)
  lastError: string | null
}

interface WizardReader {
  deviceName: string
  gateway: string
  path: string
  tags: Map<string, ReaderTagState>  // ALL tag defs, even failed ones
  pollAbort: AbortController
  lastUsedMs: number
}

// ── Constants ──────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 50       // target interval between cycles
const TAG_CREATE_TIMEOUT = 3000   // max time to wait for handle creation
const TAG_READ_TIMEOUT = 1500     // per-tag read timeout
const RETRY_INTERVAL_MS = 3000    // retry failed tag creation every 3s
const IDLE_TIMEOUT_MS = 120_000   // close orphaned readers after 2 minutes

// ── Module state ───────────────────────────────────────────────────

const readers = new Map<string, WizardReader>()

// ── Tag definitions ────────────────────────────────────────────────

function getTagDefs(deviceName: string): TagDef[] {
  return [
    { key: 'KeypadButtonF1',  tagPath: `${deviceName}:I.KeypadButtonF1`,                 dataType: 'BOOL', elemSize: 1 },
    { key: 'Check_Allowed',   tagPath: `CBT_${deviceName}.CTRL.STS.Check_Allowed`,       dataType: 'BOOL', elemSize: 1 },
    { key: 'Valid_Map',       tagPath: `CBT_${deviceName}.CTRL.STS.Valid_Map`,           dataType: 'BOOL', elemSize: 1 },
    { key: 'Valid_HP',        tagPath: `CBT_${deviceName}.CTRL.STS.Valid_HP`,            dataType: 'BOOL', elemSize: 1 },
    { key: 'Valid_Direction', tagPath: `CBT_${deviceName}.CTRL.STS.Valid_Direction`,     dataType: 'BOOL', elemSize: 1 },
    { key: 'Jogging',         tagPath: `CBT_${deviceName}.CTRL.STS.Jogging`,             dataType: 'BOOL', elemSize: 1 },
    { key: 'RVS',             tagPath: `CBT_${deviceName}.CTRL.STS.RVS`,                 dataType: 'REAL', elemSize: 4 },
  ]
}

// ── WebSocket broadcast (uses existing /broadcast HTTP→WS bridge on port 3102) ──

const BROADCAST_URL = 'http://127.0.0.1:3102/broadcast'

function broadcast(message: object): void {
  fetch(BROADCAST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  }).catch(() => { /* best-effort, ignore */ })
}

// ── Tag handle creation ────────────────────────────────────────────

/**
 * Try to create one tag handle. Returns the handle (>=0) or -1 on failure.
 * Non-blocking — uses timeout=0 + async waitForStatus.
 */
async function createOneHandle(
  gateway: string,
  path: string,
  def: TagDef,
): Promise<{ handle: number; error?: string }> {
  const handle = createTag({
    gateway,
    path,
    name: def.tagPath,
    elemSize: def.elemSize,
    elemCount: 1,
    timeout: 0,
  })

  if (handle < 0) {
    return { handle: -1, error: `createTag returned ${handle}: ${getStatusMessage(handle)}` }
  }

  const status = await waitForStatus(handle, TAG_CREATE_TIMEOUT)
  if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
    try { plc_tag_destroy(handle) } catch { /* ignore */ }
    return { handle: -1, error: `tag not ready: ${getStatusMessage(status)}` }
  }

  return { handle }
}

/**
 * Initialize the tag map. Every tag def gets a state entry — failed ones
 * have handle=-1 and will be retried by the polling loop.
 */
async function initTagMap(
  gateway: string,
  path: string,
  defs: TagDef[],
): Promise<Map<string, ReaderTagState>> {
  const tags = new Map<string, ReaderTagState>()

  for (const def of defs) {
    const result = await createOneHandle(gateway, path, def)
    tags.set(def.key, {
      def,
      handle: result.handle,
      value: 0,
      hasValue: false,
      lastErrorMs: result.handle < 0 ? Date.now() : 0,
      lastError: result.error || null,
    })
    if (result.handle < 0) {
      console.warn(`[VfdWizardReader] Initial create failed for ${def.tagPath}: ${result.error}`)
    }
  }

  return tags
}

// ── Polling loop ───────────────────────────────────────────────────

/**
 * Continuous polling loop for one VFD's tags.
 * - Reads every connected handle SEQUENTIALLY (one at a time)
 * - Retries failed handle creation every RETRY_INTERVAL_MS
 * - Always broadcasts a snapshot containing ALL tag keys (so client knows missing ones)
 *
 * IMPORTANT: Sequential reads are deliberate — they leave gaps in CIP session
 * traffic that allow write operations (e.g. write-tags-batch for Override_RVS+RVS)
 * to land cleanly. Do NOT switch to parallel reads.
 */
async function pollLoop(reader: WizardReader): Promise<void> {
  const signal = reader.pollAbort.signal

  while (!signal.aborted) {
    const cycleStart = Date.now()
    const snapshot: Record<string, number | boolean | null> = {}
    const errors: Record<string, string> = {}

    for (const [key, tag] of reader.tags.entries()) {
      // Try to repair broken handles in the background
      if (tag.handle < 0) {
        if (cycleStart - tag.lastErrorMs >= RETRY_INTERVAL_MS) {
          const result = await createOneHandle(reader.gateway, reader.path, tag.def)
          if (signal.aborted) break
          if (result.handle >= 0) {
            tag.handle = result.handle
            tag.lastError = null
            console.log(`[VfdWizardReader] Recovered tag ${tag.def.tagPath}`)
          } else {
            tag.lastErrorMs = Date.now()
            tag.lastError = result.error || 'unknown'
          }
        }
      }

      // Read if we have a handle, otherwise null
      if (tag.handle < 0) {
        snapshot[key] = null
        if (tag.lastError) errors[key] = tag.lastError
        continue
      }

      try {
        const status = await readTagAsync(tag.handle, TAG_READ_TIMEOUT)
        if (signal.aborted) break

        if (status === PlcTagStatus.PLCTAG_STATUS_OK) {
          if (tag.def.dataType === 'BOOL') {
            const bit = plc_tag_get_bit(tag.handle, 0)
            tag.value = bit
            tag.hasValue = true
            snapshot[key] = bit === 1
          } else if (tag.def.dataType === 'INT') {
            const v = plc_tag_get_int16(tag.handle, 0)
            tag.value = v
            tag.hasValue = true
            snapshot[key] = v
          } else if (tag.def.dataType === 'REAL') {
            const v = readFloat32FromTag(tag.handle, 0)
            tag.value = v
            tag.hasValue = true
            snapshot[key] = v
          }
        } else {
          snapshot[key] = null
          errors[key] = `read failed: ${getStatusMessage(status)}`
          // mark for retry
          try { plc_tag_destroy(tag.handle) } catch { /* ignore */ }
          tag.handle = -1
          tag.lastErrorMs = Date.now()
          tag.lastError = errors[key]
        }
      } catch (err) {
        snapshot[key] = null
        errors[key] = err instanceof Error ? err.message : String(err)
      }
    }

    if (signal.aborted) break

    // Always-on throttled per-device summary so field issues are debuggable
    // without rebuilding for dev mode. One line every 2s.
    {
      const now = Date.now()
      const last = (reader as any).__lastSummaryLog || 0
      if (now - last > 2000) {
        ;(reader as any).__lastSummaryLog = now
        const errSummary = Object.keys(errors).length > 0
          ? ' err=' + Object.entries(errors).map(([k, v]) => `${k}:${String(v).slice(0, 40)}`).join('|')
          : ''
        console.log(
          `[VfdWizardReader] ${reader.deviceName}` +
          ` Check_Allowed=${snapshot.Check_Allowed}` +
          ` Valid_Map=${snapshot.Valid_Map}` +
          ` Valid_HP=${snapshot.Valid_HP}` +
          ` Valid_Direction=${snapshot.Valid_Direction}` +
          ` Jogging=${snapshot.Jogging}` +
          ` RVS=${snapshot.RVS}` +
          errSummary,
        )
      }
    }

    // Broadcast snapshot — ALWAYS includes every tag key (null if missing)
    broadcast({
      type: 'VfdTagUpdate',
      deviceName: reader.deviceName,
      sts: snapshot,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      ts: Date.now(),
    })

    const cycleMs = Date.now() - cycleStart
    const delayMs = Math.max(0, POLL_INTERVAL_MS - cycleMs)
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────

export async function openWizardReader(
  deviceName: string,
  gateway: string,
  path: string,
): Promise<{ ok: boolean; tagCount: number; failedTags?: string[]; error?: string }> {
  const key = `${gateway}|${path}|${deviceName}`
  const existing = readers.get(key)
  if (existing) {
    existing.lastUsedMs = Date.now()
    const failed = Array.from(existing.tags.values())
      .filter(t => t.handle < 0)
      .map(t => t.def.tagPath)
    return { ok: true, tagCount: existing.tags.size, failedTags: failed.length > 0 ? failed : undefined }
  }

  const defs = getTagDefs(deviceName)
  const tags = await initTagMap(gateway, path, defs)
  const successCount = Array.from(tags.values()).filter(t => t.handle >= 0).length
  const failed = Array.from(tags.values())
    .filter(t => t.handle < 0)
    .map(t => t.def.tagPath)

  // Even if zero tags created, start the reader — it will retry in the background
  const reader: WizardReader = {
    deviceName,
    gateway,
    path,
    tags,
    pollAbort: new AbortController(),
    lastUsedMs: Date.now(),
  }

  readers.set(key, reader)

  pollLoop(reader).catch((err) => {
    console.error(`[VfdWizardReader] poll loop crashed for ${deviceName}:`, err)
  })

  console.log(`[VfdWizardReader] Opened reader for ${deviceName}: ${successCount}/${defs.length} tags ready, retrying ${failed.length}`)

  return {
    ok: true,
    tagCount: successCount,
    failedTags: failed.length > 0 ? failed : undefined,
  }
}

export function closeWizardReader(
  deviceName: string,
  gateway: string,
  path: string,
): void {
  const key = `${gateway}|${path}|${deviceName}`
  const reader = readers.get(key)
  if (!reader) return

  reader.pollAbort.abort()
  for (const tag of reader.tags.values()) {
    if (tag.handle >= 0) {
      try { plc_tag_destroy(tag.handle) } catch { /* ignore */ }
    }
  }
  readers.delete(key)
  console.log(`[VfdWizardReader] Closed reader for ${deviceName}`)
}

export function touchWizardReader(deviceName: string, gateway: string, path: string): void {
  const key = `${gateway}|${path}|${deviceName}`
  const reader = readers.get(key)
  if (reader) reader.lastUsedMs = Date.now()
}

// Periodic cleanup of orphaned readers
setInterval(() => {
  const now = Date.now()
  for (const [key, reader] of readers.entries()) {
    if (now - reader.lastUsedMs > IDLE_TIMEOUT_MS) {
      console.log(`[VfdWizardReader] Auto-closing idle reader for ${reader.deviceName}`)
      reader.pollAbort.abort()
      for (const tag of reader.tags.values()) {
        if (tag.handle >= 0) {
          try { plc_tag_destroy(tag.handle) } catch { /* ignore */ }
        }
      }
      readers.delete(key)
    }
  }
}, 30_000).unref?.()
