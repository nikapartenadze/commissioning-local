/**
 * VFD Validation Writer — background service that ensures PLC validation flags
 * (Valid_Map, Valid_HP, Valid_Direction) are always set for VFDs that have
 * completed their commissioning checks.
 *
 * When a VFD passes through the wizard and completes identity, HP, and direction
 * checks, the L2 spreadsheet records "Ready For Tracking" with an initials+date
 * stamp.  This service reads that L2 data and writes the corresponding CMD flags
 * to the PLC so the drives stay validated — even after a PLC power cycle or
 * controller restart.
 *
 * Performance: uses batch handle creation — all tags are created first, then a
 * tight read→set→write loop runs across all handles.  100 VFDs (300 tags) sync
 * in ~2-5 seconds, not minutes.
 *
 * Triggers:
 *   1. PLC 'initialized' event  → immediate sync of all validated VFDs
 *   2. L2 cell write / cloud pull → debounced re-sync
 *   3. Periodic safety-net      → every 60 s while PLC is connected
 *
 * Only writes "check" flags — never motor commands (Bump, Run_At_30_RVS, etc.).
 */

import { db } from '@/lib/db-sqlite'
import {
  createTag,
  plc_tag_read,
  plc_tag_write,
  plc_tag_destroy,
  plc_tag_set_int8,
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'

// ── Types ──────────────────────────────────────────────────────────

interface ValidatedDevice {
  deviceName: string
  sheetName: string
}

interface TagHandle {
  deviceName: string
  field: string
  tagPath: string
  handle: number
}

// The three validation CMD fields we assert for every validated VFD.
const CMD_FIELDS = ['Valid_Map', 'Valid_HP', 'Valid_Direction'] as const

// ── Throttle / state ───────────────────────────────────────────────

let lastSyncMs = 0
let syncRunning = false
let pendingSync = false
const MIN_SYNC_INTERVAL_MS = 5_000 // at most once per 5 s

// ── L2 query ───────────────────────────────────────────────────────

/**
 * Return every VFD device whose "Ready For Tracking" L2 cell is non-empty.
 * "Ready For Tracking" is written after wizard Step 3 (direction confirmed),
 * which implies Steps 1 (identity / map) and 2 (HP) also passed.
 */
function getValidatedDevices(): ValidatedDevice[] {
  try {
    const rows = db.prepare(`
      SELECT d.DeviceName AS deviceName, s.Name AS sheetName
      FROM L2Devices d
      JOIN L2Sheets   s  ON s.id = d.SheetId
      JOIN L2Columns  c  ON c.SheetId = d.SheetId
      JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
      WHERE c.Name = 'Ready For Tracking'
        AND cv.Value IS NOT NULL AND cv.Value != ''
        AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
    `).all() as ValidatedDevice[]
    return rows
  } catch (err) {
    console.error('[VfdValidationWriter] DB query failed:', err)
    return []
  }
}

// ── Batch write ────────────────────────────────────────────────────

/**
 * Batch-create all tag handles, then tight-loop read→set→write across them.
 *
 * Why batched?  libplctag reuses CIP sessions for tags on the same gateway+path.
 * Creating 300 handles takes ~1-2 s total (shared session setup).  The subsequent
 * read/write calls are ~5-15 ms each since the session is already open.
 * Total for 100 VFDs ≈ 2-5 seconds vs 60-90 s with per-tag create+destroy.
 */
function batchWriteFlags(
  gateway: string,
  path: string,
  devices: ValidatedDevice[],
): { ok: number; fail: number } {
  const handles: TagHandle[] = []
  let ok = 0
  let fail = 0

  try {
    // ── Phase 1: create all handles ────────────────────────────────
    for (const device of devices) {
      for (const field of CMD_FIELDS) {
        const tagPath = `CBT_${device.deviceName}.CTRL.CMD.${field}`
        const handle = createTag({
          gateway,
          path,
          name: tagPath,
          elemSize: 1,
          elemCount: 1,
          timeout: 5000,
        })
        if (handle >= 0) {
          handles.push({ deviceName: device.deviceName, field, tagPath, handle })
        } else {
          fail++
          if (fail <= 3) {
            console.warn(`[VfdValidationWriter] createTag failed: ${tagPath}: ${getStatusMessage(handle)}`)
          }
        }
      }
    }

    if (handles.length === 0) return { ok: 0, fail }

    // ── Phase 2: tight read → set → write loop ────────────────────
    for (const h of handles) {
      try {
        const readSt = plc_tag_read(h.handle, 2000)
        if (readSt !== PlcTagStatus.PLCTAG_STATUS_OK) {
          fail++
          continue
        }

        plc_tag_set_int8(h.handle, 0, 1)

        const writeSt = plc_tag_write(h.handle, 2000)
        if (writeSt === PlcTagStatus.PLCTAG_STATUS_OK) {
          ok++
        } else {
          fail++
        }
      } catch {
        fail++
      }
    }

    return { ok, fail }
  } finally {
    // ── Phase 3: destroy all handles ───────────────────────────────
    for (const h of handles) {
      try { plc_tag_destroy(h.handle) } catch { /* ignore */ }
    }
  }
}

// ── Main sync function ─────────────────────────────────────────────

/**
 * Read L2 data and write CMD validation flags for every validated VFD.
 *
 * Requires the PLC client to be connected.  `getPlcStatus` and `getPlcClient`
 * are imported lazily to avoid circular-dependency issues with
 * plc-client-manager (which imports us).
 */
export async function syncValidationFlags(): Promise<void> {
  // Throttle: don't run more than once every MIN_SYNC_INTERVAL_MS
  const now = Date.now()
  if (now - lastSyncMs < MIN_SYNC_INTERVAL_MS) {
    pendingSync = true
    return
  }
  if (syncRunning) {
    pendingSync = true
    return
  }

  syncRunning = true
  lastSyncMs = now
  pendingSync = false

  try {
    // Lazy import to break circular dep (plc-client-manager → us is fine,
    // but we also need to reach back into it for connection info).
    const { getPlcClient, getPlcStatus } = await import('@/lib/plc-client-manager')

    const client = getPlcClient()
    if (!client.isConnected) return

    const { connectionConfig } = getPlcStatus()
    if (!connectionConfig) return

    const devices = getValidatedDevices()
    if (devices.length === 0) return

    const t0 = Date.now()
    const { ok, fail } = batchWriteFlags(
      connectionConfig.ip,
      connectionConfig.path,
      devices,
    )
    const elapsed = Date.now() - t0

    console.log(
      `[VfdValidationWriter] Sync done: ${devices.length} device(s), ` +
      `${ok} ok, ${fail} failed, ${elapsed} ms`,
    )
  } catch (err) {
    console.error('[VfdValidationWriter] Sync error:', err)
  } finally {
    syncRunning = false
  }
}

// ── Public trigger (debounced) ─────────────────────────────────────

let triggerTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Request a validation sync.  Debounced — multiple rapid calls collapse
 * into one sync after a short delay.  Safe to call from API routes.
 */
export function triggerValidationSync(): void {
  if (triggerTimer) return // already scheduled
  triggerTimer = setTimeout(() => {
    triggerTimer = null
    syncValidationFlags().catch(err => {
      console.error('[VfdValidationWriter] Triggered sync error:', err)
    })
  }, 2_000) // 2 s debounce — enough for the wizard to finish its burst of L2 writes
}

// ── Periodic safety-net ────────────────────────────────────────────

setInterval(() => {
  syncValidationFlags().catch(err => {
    console.error('[VfdValidationWriter] Periodic sync error:', err)
  })

  // Also flush any deferred syncs that were throttled
  if (pendingSync) {
    pendingSync = false
    syncValidationFlags().catch(err => {
      console.error('[VfdValidationWriter] Deferred sync error:', err)
    })
  }
}, 60_000).unref?.()
