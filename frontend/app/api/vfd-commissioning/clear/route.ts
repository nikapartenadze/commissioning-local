import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { getPlcClient, getPlcStatus } from '@/lib/plc-client-manager'
import { auditLog } from '@/lib/logging/recovery-log'
import { hasMcm } from '@/lib/mcm-registry'
import {
  createTag,
  plc_tag_read,
  plc_tag_write,
  plc_tag_destroy,
  plc_tag_set_int8,
  plc_tag_get_bit,
  plc_tag_get_float32,
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'
import {
  runClearPlcSequence,
  clearStsReads,
  resolveStsFromTypedReads,
  type RetractionSts,
  type ClearPlcResult,
} from '@/lib/vfd-clear-sequence'

/**
 * POST /api/vfd-commissioning/clear
 *
 * Resets one VFD so it can be re-tested from scratch. This is the inverse of
 * what the wizard does. Because L2 cells are now the single source of truth,
 * "clear" means clearing those L2 cells (NULL-ing the Value) AND syncing the
 * deletion to the cloud, plus an optional PLC reset sequence that drops
 * STS.Valid_Map / Valid_HP / Valid_Direction, restores default-forward
 * polarity, and — new — actually invalidates the belt-tracking latch.
 *
 * The PLC part is delegated to lib/vfd-clear-sequence.ts, which owns both the
 * write ORDER and the stopped-drive guard. In brief:
 *
 *   Normal_Polarity → Invalidate_Direction → Invalidate_Tracking_Finished
 *                   → Invalidate_Map
 *
 * one field per round-trip, and only when the drive is PROVABLY not commanded
 * to move. This route previously sent Invalidate_HP FIRST and never sent
 * Invalidate_Tracking_Finished at all, which left belts latched with the
 * clearing rung dead — permanently unclearable. Do not reorder these without
 * reading the AOI ground truth quoted in vfd-clear-sequence.ts.
 *
 * Invalidate_HP IS NO LONGER SENT AT ALL. Moving it last stopped the stranding,
 * but it still dropped Valid_HP — and AOI rungs 2/3/4/5 are ALL gated on
 * XIC(Valid_HP), so that one bit is the master enable for every operator
 * keypad function (F1 start/stop, F0+F2 direction, F0/F2 speed). Clear Test
 * was handing the mechanic a drive they could neither start nor reverse. It is
 * pressed to give a belt BACK; it must not take the keypad away on the way
 * out. Invalidate_Map still goes last and still forces the next
 * re-commissioning to walk identity → HP in order (rung 1 gates OTL(Valid_HP)
 * on Valid_Map). Full reasoning in vfd-clear-sequence.ts's CLEAR_WRITE_ORDER.
 *
 * Request body:
 *   { deviceName, sheetName?, clearPlc?: true, updatedBy?, subsystemId? }
 *
 * Response:
 *   { success, deviceName, sheetName, cellsCleared, plcAttempted, plcConnected,
 *     plcResetSkipped, plcAction, plcReason, plcAborted, trackingLatchCleared,
 *     plcWrites }
 */

const COMMISSIONING_COLUMNS = [
  'Verify Identity',
  'Motor HP (Field)',
  'VFD HP (Field)',
  'Check Direction',
  'Polarity',
  'Belt Tracked',
  'Speed Set Up',
]

const stmts = {
  findDevice: db.prepare(`
    SELECT d.id as deviceId, d.SheetId, d.CloudId as deviceCloudId, d.SubsystemId as subsystemId,
           s.Name as sheetName, s.DisplayName as sheetDisplayName
    FROM L2Devices d
    JOIN L2Sheets s ON d.SheetId = s.id
    WHERE LOWER(d.DeviceName) = LOWER(?)
  `),
  findColumn: db.prepare(`
    SELECT id, Name, CloudId as columnCloudId
    FROM L2Columns
    WHERE SheetId = ? AND LOWER(TRIM(Name)) = LOWER(TRIM(?))
  `),
  getCell: db.prepare('SELECT id, Value, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  clearCell: db.prepare(`UPDATE L2CellValues SET Value = NULL, UpdatedBy = ?, UpdatedAt = datetime('now'), Version = ? WHERE id = ?`),
  insertPendingSync: db.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version) VALUES (?, ?, ?, ?, ?)'),
  countCompleted: db.prepare(`SELECT COUNT(*) as cnt FROM L2CellValues cv JOIN L2Columns lc ON cv.ColumnId = lc.id WHERE cv.DeviceId = ? AND lc.IncludeInProgress = 1 AND cv.Value IS NOT NULL AND cv.Value != ''`),
  updateDeviceChecks: db.prepare('UPDATE L2Devices SET CompletedChecks = ? WHERE id = ?'),
  getCellForPush: db.prepare('SELECT Value, Version, UpdatedBy FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  deletePendingSync: db.prepare('DELETE FROM L2PendingSyncs WHERE id = ?'),
  getLatestPendingForCell: db.prepare('SELECT id FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ? ORDER BY id DESC LIMIT 1'),
  clearControlsVerified: db.prepare('DELETE FROM VfdControlsVerified WHERE deviceName = ?'),
}

// Pulse ONE CTRL.CMD bit to 1. Every CMD bit is a self-clearing one-scan pulse
// (AOI rung 8 is FLL(0, CTRL.CMD, 1)), so there is never a matching write of 0
// — see lib/vfd-clear-sequence.ts for why CMD.Reverse_Polarity=0 was dropped.
//
// Deliberately ONE FIELD PER CALL: the sequence in vfd-clear-sequence.ts relies
// on each pulse landing in a DIFFERENT controller scan. Do not batch these.
async function pulseCmdBit(
  gateway: string,
  path: string,
  deviceName: string,
  field: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const tagPath = `CBT_${deviceName}.CTRL.CMD.${field}`
  const handle = createTag({
    gateway, path, name: tagPath, elemSize: 1, elemCount: 1, timeout: timeoutMs,
  })
  if (handle < 0) return { ok: false, error: `createTag ${tagPath}: ${getStatusMessage(handle)}` }
  try {
    const r = plc_tag_read(handle, timeoutMs)
    if (r !== PlcTagStatus.PLCTAG_STATUS_OK) return { ok: false, error: `read: ${getStatusMessage(r)}` }
    const s = plc_tag_set_int8(handle, 0, 1)
    if (s !== PlcTagStatus.PLCTAG_STATUS_OK) return { ok: false, error: `set: ${getStatusMessage(s)}` }
    const w = plc_tag_write(handle, timeoutMs)
    if (w !== PlcTagStatus.PLCTAG_STATUS_OK) return { ok: false, error: `write: ${getStatusMessage(w)}` }
    return { ok: true }
  } finally {
    try { plc_tag_destroy(handle) } catch { /* ignore */ }
  }
}

// Read one STS member. Returns null when the member does not exist on this AOI
// revision, or is otherwise unreadable — never throws. null propagates into
// planClearPlcSequence as "unprovable", which ABORTS.
function readStsMember(
  gateway: string,
  path: string,
  tagPath: string,
  kind: 'BOOL' | 'REAL',
  timeoutMs: number,
): number | null {
  const handle = createTag({
    gateway, path, name: tagPath, elemSize: kind === 'REAL' ? 4 : 1, elemCount: 1, timeout: timeoutMs,
  })
  if (handle < 0) return null
  try {
    if (plc_tag_read(handle, timeoutMs) !== PlcTagStatus.PLCTAG_STATUS_OK) return null
    if (kind === 'REAL') {
      const v = plc_tag_get_float32(handle, 0)
      return Number.isFinite(v) ? v : null
    }
    // plc_tag_get_bit, NOT get_int8: get_int8 is declared I32 over a C int8_t
    // return, so the upper register bytes are ABI garbage (same convention as
    // vfd-validation-writer / tag-reader).
    const bit = plc_tag_get_bit(handle, 0)
    return bit < 0 ? null : (bit === 0 ? 0 : 1)
  } catch {
    return null
  } finally {
    try { plc_tag_destroy(handle) } catch { /* ignore */ }
  }
}

// Build the stopped-proof snapshot on the legacy singleton path, probing BOTH
// AOI revisions' belt-tracking member names (AOI222: STS.Belt_Tracking_ON;
// older rev: STS.Track_Belt). A missing member yields null, never a throw.
function readStsForFfi(
  gateway: string,
  path: string,
  deviceName: string,
  timeoutMs: number,
): RetractionSts {
  const reads = clearStsReads(deviceName)
  const results = reads.map(rd => {
    const value = readStsMember(gateway, path, rd.name, rd.dataType, timeoutMs)
    return value === null ? { success: false } : { success: true, value }
  })
  return resolveStsFromTypedReads(results)
}

export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, sheetName, clearPlc = true, updatedBy, subsystemId } = req.body as {
      deviceName?: string
      sheetName?: string
      clearPlc?: boolean
      updatedBy?: string
      subsystemId?: string | number
    }

    if (!deviceName) {
      return res.status(400).json({ error: 'deviceName required' })
    }

    // 1. Resolve target device + sheet
    let allMatches = stmts.findDevice.all(deviceName) as Array<{
      deviceId: number; SheetId: number; deviceCloudId: number | null; subsystemId: number | null
      sheetName: string; sheetDisplayName: string | null
    }>
    if (allMatches.length === 0) {
      return res.status(404).json({ error: `No L2 device found with name "${deviceName}"` })
    }

    // Narrow to the caller's MCM FIRST. This route NULLs durable operator
    // stamps, so picking the wrong same-named row destroys another machine's
    // commissioning record (the CDW5-polarity class). Sheets are project-global
    // templates, so the sheetName tie-break below cannot separate two MCMs.
    const clearSid = Number(subsystemId)
    if (Number.isFinite(clearSid) && clearSid > 0) {
      const scoped = allMatches.filter(d => d.subsystemId === clearSid || d.subsystemId == null)
      if (scoped.length === 0) {
        return res.status(404).json({
          error: `No L2 device named "${deviceName}" belongs to subsystem ${clearSid}`,
        })
      }
      allMatches = scoped
    } else if (allMatches.length > 1) {
      const owners = Array.from(new Set(allMatches.map(d => d.subsystemId ?? 'unstamped'))).join(', ')
      return res.status(400).json({
        error: `Ambiguous device "${deviceName}": it exists on multiple MCMs (${owners}). Send subsystemId to disambiguate.`,
      })
    }

    let target = allMatches[0]
    if (sheetName) {
      const wanted = sheetName.toLowerCase().trim()
      const m = allMatches.find(d =>
        (d.sheetName || '').toLowerCase().trim() === wanted ||
        (d.sheetDisplayName || '').toLowerCase().trim() === wanted
      )
      if (m) target = m
    }

    // 2. Clear (NULL out) every commissioning cell that exists, transactionally,
    //    bumping Version so the cloud sees a fresh write to apply.
    const cloudPushQueue: Array<{ deviceId: number; columnId: number; cloudDeviceId: number; cloudColumnId: number }> = []
    let cellsCleared = 0
    // Journal entries collected in-transaction, emitted after commit — a clear
    // NULLs the durable operator stamps (CDW5-polarity incident class), so the
    // old value is recorded before it vanishes. auditLog never throws.
    const auditEntries: Array<{
      columnId: number; column: string; oldValue: string | null; version: number
      cloudColumnId: number | null
    }> = []

    db.transaction(() => {
      for (const colName of COMMISSIONING_COLUMNS) {
        const col = stmts.findColumn.get(target.SheetId, colName) as
          | { id: number; Name: string; columnCloudId: number | null } | undefined
        if (!col) continue
        const existing = stmts.getCell.get(target.deviceId, col.id) as
          | { id: number; Value: string | null; Version: number } | undefined
        if (!existing) continue
        const newVersion = existing.Version + 1
        stmts.clearCell.run(updatedBy ?? null, newVersion, existing.id)
        cellsCleared++
        auditEntries.push({
          columnId: col.id,
          column: col.Name,
          oldValue: existing.Value,
          version: newVersion,
          cloudColumnId: col.columnCloudId,
        })

        if (target.deviceCloudId && col.columnCloudId) {
          stmts.insertPendingSync.run(target.deviceCloudId, col.columnCloudId, null, updatedBy ?? null, newVersion - 1)
          cloudPushQueue.push({
            deviceId: target.deviceId,
            columnId: col.id,
            cloudDeviceId: target.deviceCloudId,
            cloudColumnId: col.columnCloudId,
          })
        }
      }

      // Refresh derived progress counter on the device row
      const completedCount = stmts.countCompleted.get(target.deviceId) as { cnt: number }
      stmts.updateDeviceChecks.run(completedCount?.cnt || 0, target.deviceId)

      // Also clear the local-only "Controls Verified" state
      stmts.clearControlsVerified.run(deviceName)
    })()

    // Durable recovery trail for each NULLed cell — same 'l2.cell' shape as
    // app/api/l2/cell/route.ts and write-l2-cells so tooling parses all three.
    for (const entry of auditEntries) {
      auditLog({
        type: 'l2.cell',
        subsystemId: target.subsystemId ?? null,
        user: updatedBy ?? null,
        version: entry.version,
        detail: {
          deviceId: target.deviceId,
          columnId: entry.columnId,
          cloudDeviceId: target.deviceCloudId,
          cloudColumnId: entry.cloudColumnId,
          deviceName,
          column: entry.column,
          oldValue: entry.oldValue,
          value: null,
          via: 'vfd-clear',
        },
      })
    }

    // 3. Best-effort cloud push for each cleared cell
    for (const push of cloudPushQueue) {
      const key = `l2cell:${push.deviceId}-${push.columnId}`
      enqueueSyncPush(key, async () => {
        const cell = stmts.getCellForPush.get(push.deviceId, push.columnId) as
          | { Value: string | null; Version: number; UpdatedBy: string | null } | undefined
        if (!cell) return
        const config = await configService.getConfig()
        if (!config.remoteUrl) return
        try {
          const resp = await fetch(`${config.remoteUrl}/api/sync/l2/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword || '' },
            body: JSON.stringify({
              updates: [{
                deviceId: push.cloudDeviceId,
                columnId: push.cloudColumnId,
                value: cell.Value, // null
                version: cell.Version - 1,
                updatedBy: cell.UpdatedBy || 'unknown',
              }],
            }),
            signal: AbortSignal.timeout(10000),
          })
          if (!resp.ok) return
          const data = await resp.json().catch(() => null) as any
          const wasUpdated = data?.updates?.some((u: any) => u.deviceId === push.cloudDeviceId && u.columnId === push.cloudColumnId)
          if (wasUpdated) {
            try {
              const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
              getCloudSseClient()?.trackPushedL2Id(push.cloudDeviceId, push.cloudColumnId)
            } catch {}
            try {
              const pending = stmts.getLatestPendingForCell.get(push.cloudDeviceId, push.cloudColumnId) as { id: number } | undefined
              if (pending) stmts.deletePendingSync.run(pending.id)
            } catch {}
          }
        } catch (err) {
          console.warn('[VFD Clear] Cloud push failed:', err instanceof Error ? err.message : err)
        }
      })
    }

    // 4. Optional: PLC reset pulses.
    //    MCM-aware (central server): when the caller names a registry MCM,
    //    pulse THAT controller; otherwise the legacy active-subsystem
    //    singleton (hasMcm gate — same convention as /api/ios — so a legacy
    //    tablet sending its active subsystemId still uses the singleton).
    //    Best-effort either way: L2 cells are already cleared above.
    //
    //    BOTH branches now go through runClearPlcSequence (lib/vfd-clear-
    //    sequence.ts), which owns the write ORDER and the stopped-drive guard.
    //    Read that file before changing anything here — the order is load-
    //    bearing against the AOI's rung structure, not cosmetic.
    const plcWrites: Array<{ field: string; ok: boolean; error?: string; skipped?: boolean }> = []
    let plcAttempted = false
    let plcSequence: ClearPlcResult | null = null
    // Whether the target PLC was actually reachable when clearPlc was requested.
    // Distinct from plcAttempted (which is only ever true when connected): it
    // lets the client tell "PLC reset not requested" from "requested but the
    // controller was offline, so the physical latch reset was SKIPPED" — the
    // MCM14 latch-confusion class, where a silent skip left stale latches.
    let plcConnected = false
    if (clearPlc) {
      if (subsystemId !== undefined && subsystemId !== null && subsystemId !== '' && hasMcm(String(subsystemId))) {
        // Registry MCM: read the stopped-proof snapshot, then pulse through the
        // mode-aware typed ops — executed in-process (embedded) or in the
        // plc-gateway (PLC_MODE=remote, Phase 1.1).
        //
        // ONE FIELD PER CALL, sequentially. This used to be a single 5-tag
        // batch; the gateway is free to order a batch as it likes, and even a
        // faithfully-ordered batch can land inside ONE controller scan — where
        // rung 3's branches evaluate top-to-bottom, so OTU(Tracking_Finished)
        // runs before the XIC(Tracking_Finished) branch that honours
        // Normal_Polarity, and the polarity reset is silently lost.
        const { writeTypedTagsForMcm, readTypedTagsForMcm } = await import('@/lib/mcm-registry')
        const sid = String(subsystemId)
        const stsBatch = await readTypedTagsForMcm(sid, clearStsReads(deviceName))
        if (stsBatch.connected) {
          plcConnected = true
          plcAttempted = true
          plcSequence = await runClearPlcSequence(
            resolveStsFromTypedReads(stsBatch.results),
            async (field) => {
              const w = await writeTypedTagsForMcm(sid, [
                { name: `CBT_${deviceName}.CTRL.CMD.${field}`, value: 1, dataType: 'BOOL' },
              ])
              if (!w.connected) return { ok: false, error: `MCM ${sid} disconnected mid-sequence` }
              const res = w.results[0]
              return { ok: !!res?.success, error: res?.error }
            },
          )
          plcWrites.push(...plcSequence.writes)
        }
        // Not connected → best-effort skip: L2 cells are already cleared.
      } else {
        const client = getPlcClient()
        const { connectionConfig } = getPlcStatus()
        if (client.isConnected && connectionConfig) {
          plcConnected = true
          plcAttempted = true
          const timeoutMs = connectionConfig.timeout || 5000
          const { ip, path } = connectionConfig
          plcSequence = await runClearPlcSequence(
            readStsForFfi(ip, path, deviceName, timeoutMs),
            (field) => pulseCmdBit(ip, path, deviceName, field, timeoutMs),
          )
          plcWrites.push(...plcSequence.writes)
        }
      }

      if (plcSequence && plcSequence.action !== 'proceed') {
        console.warn(
          `[VFD Clear] ${deviceName}: PLC sequence ${plcSequence.action} — ${plcSequence.reason}`,
        )
      }
    }

    return res.json({
      success: true,
      deviceName,
      sheetName: target.sheetName,
      cellsCleared,
      plcAttempted,
      plcConnected,
      // True when the caller asked for the PLC latch reset but the controller
      // was offline, so the Invalidate_* / polarity pulses did NOT run. The L2
      // cells are cleared either way; the client should warn the operator to
      // reset the latches once the PLC is back.
      plcResetSkipped: clearPlc === true && !plcConnected,
      // The stopped-drive guard's verdict. 'abort' means NOTHING was written:
      // the drive was running, or we could not PROVE it was stopped. The
      // operator must stop the belt and clear again — the L2 cells are already
      // cleared, but the controller still holds its latches.
      plcAction: plcSequence?.action ?? null,
      plcReason: plcSequence?.reason ?? null,
      plcAborted: plcSequence?.action === 'abort',
      // True only when Invalidate_Tracking_Finished actually went out. When
      // false with plcAttempted true, the belt-tracking latch is still set.
      trackingLatchCleared: plcSequence?.latchCleared ?? false,
      plcWrites,
    })
  } catch (error) {
    console.error('[VFD Clear] Error:', error)
    return res.status(500).json({ error: `Clear failed: ${error instanceof Error ? error.message : error}` })
  }
}
