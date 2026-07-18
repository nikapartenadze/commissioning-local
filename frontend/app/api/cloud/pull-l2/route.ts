/**
 * POST /api/cloud/pull-l2 — Pull only L2/FV data from cloud
 *
 * Body: { remoteUrl: string, apiPassword?: string, subsystemId: number }
 *
 * Standalone FV pull — does NOT touch IOs, network, estop etc.
 * Used by the FV page retry button when the initial full pull missed FV data.
 */

import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { computeAtRiskL2Cells, parseDbTimestamp, type LocalL2Cell } from '@/lib/cloud/pull-guard'
import { auditLog } from '@/lib/logging/recovery-log'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types'

export async function POST(req: Request, res: Response) {
  try {
    const { subsystemId } = req.body || {}
    const force = req.body?.force === true

    if (!subsystemId) {
      return res.status(400).json({ success: false, error: 'subsystemId is required' })
    }

    // Resolve cloud creds SERVER-side. The body may still carry remoteUrl/
    // apiPassword (legacy callers / the IO pull self-call), but clients should
    // NOT have to ship the API key: since the H1 change the browser no longer
    // receives it. Fall back to the saved config when the body omits them.
    const cfg = await configService.getConfig()
    const remoteUrl = (req.body?.remoteUrl || cfg.remoteUrl || EMBEDDED_REMOTE_URL || '').replace(/\/$/, '')
    const apiPassword = req.body?.apiPassword || cfg.apiPassword || ''

    if (!remoteUrl) {
      return res.status(400).json({ success: false, error: 'No cloud URL configured' })
    }

    // ── Pending-queue guard (F5, 2026-07-03 sync audit) ─────────────────
    // The rewrite below DELETEs this subsystem's L2 devices + cells. An
    // unsynced L2PendingSyncs row (active OR parked) is local FV truth that
    // has not reached the cloud — wiping it here loses it. Mirrors the IO
    // pull's pending-queue block; drain/resolve the queue first.
    //
    // ORPHANED rows (Orphaned=1) are EXCLUDED from the block: they exist
    // precisely because the cloud DELETED their device, and THIS pull is what
    // restores it — blocking on them would deadlock the very recovery that
    // auto-requeues them. Only active + parked-non-orphaned genuine unsynced
    // work blocks the pull.
    const l2QueueCounts = db.prepare(
      `SELECT
         SUM(CASE WHEN DeadLettered = 0 THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN DeadLettered = 1 AND Orphaned = 0 THEN 1 ELSE 0 END) as parked
       FROM L2PendingSyncs
       WHERE CloudDeviceId IN (SELECT CloudId FROM L2Devices WHERE SubsystemId = ? OR SubsystemId IS NULL)`,
    ).get(Number(subsystemId)) as { active: number | null; parked: number | null }
    const l2Active = l2QueueCounts.active ?? 0
    const l2Parked = l2QueueCounts.parked ?? 0
    if (l2Active + l2Parked > 0) {
      const parts = [
        l2Active > 0 ? `sync ${l2Active} pending FV cell change(s) first` : null,
        l2Parked > 0 ? `resolve ${l2Parked} parked FV cell(s) the cloud rejected` : null,
      ].filter(Boolean).join('; ')
      return res.status(409).json({
        success: false,
        error: `FV pull blocked to protect unsynced local FV data: ${parts}.`,
      })
    }

    const l2Url = `${remoteUrl}/api/sync/l2/${subsystemId}`
    console.log(`[L2Pull] Fetching FV data from: ${l2Url}`)
    console.log(`[L2Pull] API key: ${apiPassword ? `set (${apiPassword.length} chars)` : 'NOT SET'}`)

    const l2Res = await fetch(l2Url, {
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
      signal: AbortSignal.timeout(30000),
    })

    console.log(`[L2Pull] Cloud response: ${l2Res.status} ${l2Res.statusText}`)

    if (!l2Res.ok) {
      const errorText = await l2Res.text().catch(() => '(could not read response body)')
      const msg = `Cloud returned HTTP ${l2Res.status}: ${errorText.slice(0, 300)}`
      console.error(`[L2Pull] FAILED: ${msg}`)

      if (l2Res.status === 404) {
        return res.json({ success: true, l2Pulled: 0, l2CellsPulled: 0, error: 'L2 endpoint not found on cloud (404)' })
      }
      if (l2Res.status === 401) {
        return res.status(401).json({ success: false, error: 'API key rejected by cloud (401 Unauthorized)' })
      }
      if (l2Res.status === 403) {
        return res.status(403).json({ success: false, error: 'API key not authorized for this subsystem (403 Forbidden)' })
      }
      return res.status(502).json({ success: false, error: msg })
    }

    const data = await l2Res.json()
    console.log(`[L2Pull] Parsed: success=${data.success}, sheets=${data.sheets?.length || 0}, devices=${data.devices?.length || 0}, cellValues=${data.cellValues?.length || 0}`)

    if (!data.success) {
      const msg = data.error || 'Cloud returned success=false (unknown reason)'
      console.error(`[L2Pull] Cloud error: ${msg}`)
      return res.status(502).json({ success: false, error: msg })
    }

    if (!data.sheets || data.sheets.length === 0) {
      console.warn('[L2Pull] No sheets — no L2 template configured on cloud for this project')
      return res.json({ success: true, l2Pulled: 0, l2CellsPulled: 0, message: 'No FV template configured on cloud' })
    }

    // ── FV result-loss guard (F5) ────────────────────────────────────────
    // Second line of defense that does not trust the queue (the MCM08/MCM17
    // lesson): compare actual local cell values against the actual cloud
    // payload and refuse when the wipe would destroy local FV work the cloud
    // does not have (or holds an older value for). body.force overrides after
    // explicit user confirmation.
    const localCells = db.prepare(
      `SELECT d.CloudId as deviceCloudId, c.CloudId as columnCloudId,
              d.DeviceName as deviceName, c.Name as columnName,
              v.Value as value, v.UpdatedAt as updatedAt
       FROM L2CellValues v
       JOIN L2Devices d ON d.id = v.DeviceId
       JOIN L2Columns c ON c.id = v.ColumnId
       WHERE (d.SubsystemId = ? OR d.SubsystemId IS NULL)
         AND v.Value IS NOT NULL AND TRIM(v.Value) != ''`,
    ).all(Number(subsystemId)) as LocalL2Cell[]
    const queuedKeys = new Set(
      (db.prepare('SELECT CloudDeviceId, CloudColumnId FROM L2PendingSyncs').all() as Array<{ CloudDeviceId: number; CloudColumnId: number }>)
        .map(r => `${r.CloudDeviceId}-${r.CloudColumnId}`),
    )
    const atRiskCells = computeAtRiskL2Cells(localCells, data.cellValues || [], queuedKeys)
    if (atRiskCells.length > 0) {
      // With the NON-DESTRUCTIVE merge below these cells are NOT destroyed — the
      // merge keeps every local-filled / local-newer cell and only adds or
      // refreshes from cloud. We no longer REFUSE the pull for them: the old
      // 409-refuse existed because the pull used to DELETE+reinsert, and it also
      // blocked safe pulls (leaving tablets stale). Logged for visibility only.
      const byReason = { unmapped: 0, 'cloud-missing': 0, 'local-newer': 0 } as Record<string, number>
      for (const c of atRiskCells) byReason[c.reason]++
      console.warn(
        `[L2Pull] ${atRiskCells.length} local FV cell(s) absent from / older-than the cloud payload ` +
        `(${byReason['cloud-missing']} cloud-missing, ${byReason['local-newer']} locally-newer, ${byReason.unmapped} unmapped) — ` +
        'preserved by the non-destructive merge (never deleted).',
      )
    }

    // Pre-pull safety backup. FV/L2 cell values are real commissioning work and
    // the rewrite below is DESTRUCTIVE for this subsystem's devices/cells — if
    // the backup fails, ABORT rather than wipe with no safety net (mirrors the
    // IO pull's B6). Closes the pre-existing L2 data-loss hole (pull-l2 used to
    // DELETE every L2 cell value with no backup at all).
    try {
      const { createBackup } = await import('@/lib/db/backup')
      const backup = await createBackup(`pre-pull-l2-mcm${subsystemId}`)
      console.log(`[L2Pull] Auto-backup created: ${backup.filename}`)
    } catch (backupErr) {
      console.error('[L2Pull] Pre-pull backup FAILED — aborting to protect local FV data:', backupErr)
      return res.status(500).json({ success: false, error: 'Pre-pull safety backup failed; L2 pull aborted to protect local data.' })
    }

    const sid = Number(subsystemId)
    let l2Pulled = 0
    let l2CellsPulled = 0

    const result = db.transaction(() => {
      // Sheets + columns are PROJECT-GLOBAL templates shared by every MCM —
      // UPSERT them by CloudId so repeated per-MCM pulls neither duplicate nor
      // clobber them (and don't churn local ids).
      const findSheet = db.prepare('SELECT id FROM L2Sheets WHERE CloudId = ?')
      const insertSheet = db.prepare('INSERT INTO L2Sheets (CloudId, Name, DisplayName, DisplayOrder, Discipline, DeviceCount) VALUES (?, ?, ?, ?, ?, ?)')
      const updateSheet = db.prepare('UPDATE L2Sheets SET Name=?, DisplayName=?, DisplayOrder=?, Discipline=?, DeviceCount=? WHERE id=?')
      const findCol = db.prepare('SELECT id FROM L2Columns WHERE CloudId = ?')
      const insertCol = db.prepare('INSERT INTO L2Columns (CloudId, SheetId, Name, ColumnType, InputType, DisplayOrder, IsSystem, IsEditable, IncludeInProgress, IsRequired, Description, ApplicableMcms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const updateCol = db.prepare('UPDATE L2Columns SET SheetId=?, Name=?, ColumnType=?, InputType=?, DisplayOrder=?, IsSystem=?, IsEditable=?, IncludeInProgress=?, IsRequired=?, Description=?, ApplicableMcms=? WHERE id=?')
      // NON-DESTRUCTIVE upsert stmts (2026-07-08 FV-loss fix): devices matched
      // by CloudId and UPDATED in place (no delete); cells merged last-write-wins
      // by (DeviceId, ColumnId) — never deleted, never blanked.
      const findDev = db.prepare('SELECT id FROM L2Devices WHERE CloudId = ?')
      const insertDev = db.prepare('INSERT INTO L2Devices (CloudId, SubsystemId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder, CompletedChecks, TotalChecks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const updateDev = db.prepare('UPDATE L2Devices SET SubsystemId=?, SheetId=?, DeviceName=?, Mcm=?, Subsystem=?, DisplayOrder=?, CompletedChecks=?, TotalChecks=? WHERE id=?')
      // Auto-requeue: a device that reappears on cloud un-orphans its queue
      // rows (Orphaned→0, back to Active) so held local FV values drain again,
      // values intact. Keyed by CloudDeviceId (= the cloud device id).
      const requeueOrphanedL2 = db.prepare(
        'UPDATE L2PendingSyncs SET Orphaned = 0, DeadLettered = 0, RetryCount = 0, LastError = NULL WHERE CloudDeviceId = ? AND Orphaned = 1',
      )
      const getCell = db.prepare('SELECT id, Value, UpdatedAt, Version FROM L2CellValues WHERE DeviceId=? AND ColumnId=?')
      const insertCell = db.prepare('INSERT INTO L2CellValues (CloudCellId, DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      const fillCell = db.prepare('UPDATE L2CellValues SET CloudCellId=?, Value=?, UpdatedBy=?, UpdatedAt=?, Version=? WHERE id=?')

      const sheetIdMap = new Map<number, number>()
      const columnIdMap = new Map<number, number>()
      const deviceIdMap = new Map<number, number>()

      for (const sheet of data.sheets) {
        const existing = findSheet.get(sheet.id) as { id: number } | undefined
        let localSheetId: number
        if (existing) {
          localSheetId = existing.id
          updateSheet.run(sheet.name, sheet.displayName, sheet.displayOrder, sheet.discipline, sheet.deviceCount || 0, localSheetId)
        } else {
          localSheetId = insertSheet.run(sheet.id, sheet.name, sheet.displayName, sheet.displayOrder, sheet.discipline, sheet.deviceCount || 0).lastInsertRowid as number
        }
        sheetIdMap.set(sheet.id, localSheetId)
        for (const col of (sheet.columns || [])) {
          const colArgs = [
            localSheetId, col.name, col.columnType, col.inputType || col.columnType, col.displayOrder,
            col.isSystem ? 1 : 0, col.isEditable === false ? 0 : 1, col.includeInProgress ? 1 : 0,
            col.isRequired ? 1 : 0, col.description || null, col.applicableMcms ?? null,
          ]
          const ec = findCol.get(col.id) as { id: number } | undefined
          let localColId: number
          if (ec) {
            localColId = ec.id
            updateCol.run(...colArgs, localColId)
          } else {
            localColId = insertCol.run(col.id, ...colArgs).lastInsertRowid as number
          }
          columnIdMap.set(col.id, localColId)
        }
      }

      // ── NON-DESTRUCTIVE merge (2026-07-08 FV-loss fix) ───────────────────
      // TWO-LAYER model: the cloud owns STRUCTURE (sheets/columns/devices — add/
      // rename/move/delete), the FIELD owns VALUES (operator-entered test data).
      // So a pull applies structure via upsert (devices matched by CloudId, updated
      // in place; guarded prune below). For VALUES it: (a) INSERTS a cell the local
      // tool is MISSING (first-load / restore of a wiped tool; also how a cloud-
      // authored value first lands), (b) may FILL a local cell that EXISTS but is
      // EMPTY — this is the belt-tracking handoff, where the mechanical fills the
      // "Belt Tracked" L2 cell on the cloud page and the field wizard waits for it —
      // and (c) NEVER overwrites or blanks a FILLED local cell (operator test data
      // flows UP only). This replaced the OLD delete-all+reinsert that wiped 116
      // real cells on MCM02/14/18 (all safe on cloud). See FV-IO-Sync-Architecture.
      let cellsInserted = 0, keptLocalExisting = 0, cellsOverwritten = 0
      for (const dev of (data.devices || [])) {
        const localSheetId = sheetIdMap.get(dev.sheetId)
        if (!localSheetId) continue
        const ex = findDev.get(dev.id) as { id: number } | undefined
        let localDevId: number
        if (ex) {
          localDevId = ex.id
          updateDev.run(sid, localSheetId, dev.deviceName, dev.mcm, dev.subsystem, dev.displayOrder, dev.completedChecks || 0, dev.totalChecks || 0, localDevId)
        } else {
          localDevId = insertDev.run(dev.id, sid, localSheetId, dev.deviceName, dev.mcm, dev.subsystem, dev.displayOrder, dev.completedChecks || 0, dev.totalChecks || 0).lastInsertRowid as number
        }
        // This device is present on cloud → un-orphan any queue rows that were
        // orphaned when it had been deleted (delete-then-restore recovery).
        requeueOrphanedL2.run(dev.id)
        deviceIdMap.set(dev.id, localDevId)
        l2Pulled++
      }

      let cellsFilled = 0
      for (const cell of (data.cellValues || [])) {
        const ld = deviceIdMap.get(cell.deviceId)
        const lc = columnIdMap.get(cell.columnId)
        if (!ld || !lc) continue
        const cloudFilled = cell.value != null && String(cell.value).trim() !== ''
        const ver = Number(cell.version) || 0
        const ex = getCell.get(ld, lc) as { id: number; Value: string | null; UpdatedAt: string | null; Version: number | null } | undefined
        if (!ex) {
          // Local is MISSING this cell → INSERT it (first-load / restore of a
          // wiped tool; also how a cloud-authored value first lands).
          insertCell.run(cell.id, ld, lc, cell.value, cell.updatedBy, cell.updatedAt, ver)
          cellsInserted++; l2CellsPulled++
          continue
        }
        const localFilled = ex.Value != null && String(ex.Value).trim() !== ''
        if (localFilled) {
          // FILLED local cell. The field still owns VALUES, but a cloud-authored
          // CORRECTION must be able to reach a tablet that already has a value —
          // otherwise an admin fix (or a peer's newer edit) can NEVER land here
          // (the "Pull doesn't pull latest FV" gap). Overwrite ONLY when ALL hold:
          //   - the cell has NO un-pushed local edit (queuedKeys; the whole pull
          //     is also 409'd upstream when the subsystem has any active/parked
          //     pending L2 sync, so this is defense-in-depth for orphaned rows),
          //   - the cloud carries a non-empty value that DIFFERS from local, and
          //   - the cloud is STRICTLY newer — higher Version, or equal Version
          //     with a strictly newer UpdatedAt (version primary, timestamp
          //     tiebreak). A local edit bumps Version AND queues a pending row, so
          //     a non-pending filled cell reflects a previously-synced state; a
          //     strictly-newer cloud value is therefore a genuine later edit, not
          //     unsynced field work. Otherwise the field's value stands.
          const hasPendingEdit = queuedKeys.has(`${cell.deviceId}-${cell.columnId}`)
          const localVer = Number(ex.Version) || 0
          let cloudNewer = ver > localVer
          if (!cloudNewer && ver === localVer) {
            const cloudTs = parseDbTimestamp(cell.updatedAt)
            const localTs = parseDbTimestamp(ex.UpdatedAt)
            cloudNewer = Number.isFinite(cloudTs) && Number.isFinite(localTs) && cloudTs > localTs
          }
          if (!hasPendingEdit && cloudFilled && String(cell.value) !== String(ex.Value) && cloudNewer) {
            fillCell.run(cell.id, cell.value, cell.updatedBy, cell.updatedAt, ver, ex.id)
            cellsOverwritten++; l2CellsPulled++
            continue
          }
          keptLocalExisting++
          continue
        }
        // Local cell EXISTS but is EMPTY. A cloud-authored value must be able to
        // FILL it — this is the belt-tracking handoff: the mechanical fills the
        // "Belt Tracked" L2 cell on the cloud page and the field wizard waits for
        // it to arrive here. Filling a blank never destroys operator work. Guard
        // the rare "operator just cleared this cell" case: only accept the cloud
        // value if the local blank is NOT strictly newer than the cloud value.
        if (cloudFilled) {
          const localTs = parseDbTimestamp(ex.UpdatedAt)
          const cloudTs = parseDbTimestamp(cell.updatedAt)
          const localBlankIsNewer = Number.isFinite(localTs) && Number.isFinite(cloudTs) && localTs > cloudTs
          if (!localBlankIsNewer) {
            fillCell.run(cell.id, cell.value, cell.updatedBy, cell.updatedAt, ver, ex.id)
            cellsFilled++; l2CellsPulled++
            continue
          }
        }
        keptLocalExisting++
      }

      // ── Guarded structural reconciliation (device moves / deletes) ───────
      // Proper structure sync: a device genuinely deleted (or moved out) on
      // cloud should disappear locally too. But we ONLY prune EMPTY orphans and
      // ONLY when the cloud has declared this payload the COMPLETE authoritative
      // device set for the subsystem (data.authoritativeComplete). A device that
      // holds ANY filled cell — or has unsynced pending work — is NEVER pruned,
      // so a partial/mismatched payload can never delete real FV work. This is
      // the structural half of the two-layer model (cloud owns structure, field
      // owns values); without the completeness flag we skip pruning entirely.
      let devicesPruned = 0
      if (data.authoritativeComplete === true) {
        const servedCloudIds = new Set<number>((data.devices || []).map((d: { id: number }) => Number(d.id)))
        const localDevs = db.prepare('SELECT id, CloudId FROM L2Devices WHERE SubsystemId = ?').all(sid) as Array<{ id: number; CloudId: number | null }>
        const filledCountStmt = db.prepare("SELECT COUNT(*) c FROM L2CellValues WHERE DeviceId = ? AND Value IS NOT NULL AND TRIM(Value) <> ''")
        const pendingForDevStmt = db.prepare('SELECT COUNT(*) c FROM L2PendingSyncs WHERE CloudDeviceId = ?')
        const deleteCellsStmt = db.prepare('DELETE FROM L2CellValues WHERE DeviceId = ?')
        const deleteDevStmt = db.prepare('DELETE FROM L2Devices WHERE id = ?')
        for (const ld of localDevs) {
          if (ld.CloudId != null && servedCloudIds.has(ld.CloudId)) continue // still present on cloud
          const filled = (filledCountStmt.get(ld.id) as { c: number }).c
          if (filled > 0) continue // has real work — NEVER delete
          // Defensive depth: the top-of-handler pending-queue guard already 409s
          // the whole pull when this subsystem has ANY L2PendingSyncs, so this
          // inner check is redundant today — kept so the prune stays safe even if
          // that upstream guard is ever relaxed.
          const pend = ld.CloudId != null ? (pendingForDevStmt.get(ld.CloudId) as { c: number }).c : 0
          if (pend > 0) continue // unsynced work — keep
          deleteCellsStmt.run(ld.id) // drop any empty cell rows first (no filled ones exist)
          deleteDevStmt.run(ld.id)
          devicesPruned++
        }
      }

      return { sheetsCount: data.sheets.length, l2Pulled, l2CellsPulled, cellsInserted, cellsFilled, cellsOverwritten, keptLocalExisting, devicesPruned }
    })()

    console.log(
      `[L2Pull] SUCCESS (structure + values-down-into-empty + newer-cloud-corrections): ${result.sheetsCount} sheets, ` +
      `${result.l2Pulled} devices, ${result.cellsInserted} missing cell(s) inserted, ` +
      `${result.cellsFilled} empty local cell(s) filled from cloud (e.g. belt-tracked), ` +
      `${result.cellsOverwritten} filled local cell(s) updated from a strictly-newer cloud value, ` +
      `${result.keptLocalExisting} filled local cell(s) kept (field owns values), ` +
      `${result.devicesPruned} empty orphan device(s) pruned`,
    )

    // Durable recovery-log trace of every FV merge. The pull is now
    // non-destructive (upsert, no delete), and we record exactly what changed —
    // inserted/updated/kept — so any future FV movement is always traceable
    // (closes the MCM17 audit gap AND the "what did the pull clear?" gap: the
    // answer is now "nothing — it never deletes").
    auditLog({
      type: 'sync.pull',
      subsystemId: Number(subsystemId),
      detail: {
        route: 'pull-l2',
        destructive: false,
        force,
        sheetsCount: result.sheetsCount,
        l2Pulled: result.l2Pulled,
        l2CellsPulled: result.l2CellsPulled,
        cellsInserted: result.cellsInserted,
        cellsFilled: result.cellsFilled,
        cellsOverwritten: result.cellsOverwritten,
        keptLocalExisting: result.keptLocalExisting,
        devicesPruned: result.devicesPruned,
        authoritativeComplete: data.authoritativeComplete === true,
        overrodeAtRiskCells: atRiskCells.length,
      },
    })

    // Sync VFD validation flags to PLC for pulled L2 data
    if (result.l2CellsPulled > 0) {
      import('@/lib/vfd-validation-writer')
        .then(m => m.triggerValidationSync())
        .catch(() => { /* best-effort */ })
    }

    return res.json({
      success: true,
      l2Pulled: result.l2Pulled,
      l2CellsPulled: result.l2CellsPulled,
      sheetsCount: result.sheetsCount,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[L2Pull] EXCEPTION:', msg)
    return res.status(500).json({ success: false, error: msg })
  }
}
