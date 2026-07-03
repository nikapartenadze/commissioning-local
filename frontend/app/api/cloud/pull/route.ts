import { Request, Response } from 'express'
import { db, extractDeviceName } from '@/lib/db-sqlite'
import { getWsBroadcastUrl, getPlcClient } from '@/lib/plc-client-manager'
import { createBackup } from '@/lib/db/backup'
import { computeAtRiskResults, computeAtRiskComments, computeDivergentUnqueuedResults } from '@/lib/cloud/pull-guard'
import { runConfigSidePulls } from '@/lib/cloud/config-side-pulls'
import { auditLog } from '@/lib/logging/recovery-log'
import { configService } from '@/lib/config'
import type { CloudPullResponse } from '@/lib/cloud/types'

// ── Prepared statements (created once at module load) ──────────────────
// Lazy-initialized prepared statements — created on first use, not at import time.
// This prevents crashes when the database schema is older than the SQL expects
// (e.g., dev databases missing columns that production databases have).
let _pullStmts: ReturnType<typeof createPullStmts> | null = null
function getPullStmts() {
  if (!_pullStmts) _pullStmts = createPullStmts()
  return _pullStmts
}
function createPullStmts() {
  return {
    pendingIoCount: db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs'),
    pendingL2Count: db.prepare('SELECT COUNT(*) as cnt FROM L2PendingSyncs WHERE DeadLettered = 0'),
    pendingChangeRequestCount: db.prepare("SELECT COUNT(*) as cnt FROM ChangeRequests WHERE Status = 'pending' AND CloudId IS NULL"),
    pendingEStopCheckCount: db.prepare('SELECT COUNT(*) as cnt FROM EStopCheckPendingSyncs'),
    pendingGuidedTaskCount: db.prepare('SELECT COUNT(*) as cnt FROM GuidedTaskStatePendingSyncs'),
    ioCount: db.prepare('SELECT COUNT(*) as cnt FROM Ios'),
    getProject: db.prepare('SELECT id FROM Projects WHERE id = ?'),
    insertProject: db.prepare('INSERT INTO Projects (id, Name) VALUES (?, ?)'),
    getSubsystem: db.prepare('SELECT id FROM Subsystems WHERE id = ?'),
    insertSubsystem: db.prepare('INSERT INTO Subsystems (id, ProjectId, Name) VALUES (?, ?, ?)'),
    deleteAllIos: db.prepare('DELETE FROM Ios'),
    upsertIo: db.prepare(`
      INSERT INTO Ios (id, Name, Description, SubsystemId, Result, Comments, Timestamp, TestedBy, IoNumber, InstallationStatus, InstallationPercent, PoweredUp, TagType, Version, Trade, ClarificationNote, NetworkDeviceName, PunchlistStatus, CloudSyncedAt, "Order")
      VALUES (@id, @Name, @Description, @SubsystemId, @Result, @Comments, @Timestamp, @TestedBy, @IoNumber, @InstallationStatus, @InstallationPercent, @PoweredUp, @TagType, @Version, @Trade, @ClarificationNote, @NetworkDeviceName, @PunchlistStatus, @CloudSyncedAt, @Order)
      ON CONFLICT(id) DO UPDATE SET
        Name = @Name, Description = @Description, SubsystemId = @SubsystemId,
        Result = CASE WHEN Ios.Result IS NOT NULL AND Ios.Result != '' THEN Ios.Result ELSE @Result END,
        Comments = CASE WHEN Ios.Comments IS NOT NULL AND Ios.Comments != '' THEN Ios.Comments ELSE @Comments END,
        Timestamp = CASE WHEN Ios.Timestamp IS NOT NULL THEN Ios.Timestamp ELSE @Timestamp END,
        TestedBy = CASE WHEN Ios.TestedBy IS NOT NULL AND Ios.TestedBy != '' THEN Ios.TestedBy ELSE @TestedBy END,
        IoNumber = @IoNumber, InstallationStatus = @InstallationStatus,
        InstallationPercent = @InstallationPercent, PoweredUp = @PoweredUp,
        TagType = CASE WHEN @TagType IS NOT NULL THEN @TagType ELSE Ios.TagType END,
        Version = @Version, Trade = @Trade, ClarificationNote = @ClarificationNote,
        NetworkDeviceName = @NetworkDeviceName,
        PunchlistStatus = CASE WHEN @PunchlistStatus IS NOT NULL THEN @PunchlistStatus ELSE Ios.PunchlistStatus END,
        CloudSyncedAt = @CloudSyncedAt,
        "Order" = @Order
    `),
    getIosWithoutDevice: db.prepare('SELECT id, Name FROM Ios WHERE NetworkDeviceName IS NULL'),
    updateDeviceName: db.prepare('UPDATE Ios SET NetworkDeviceName = ? WHERE id = ?'),
    deleteHistories: db.prepare('DELETE FROM TestHistories'),
    insertHistory: db.prepare(`INSERT OR IGNORE INTO TestHistories (IoId, Result, TestedBy, Comments, FailureMode, State, Timestamp, Source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    getUntypedIos: db.prepare('SELECT id, Description FROM Ios WHERE TagType IS NULL AND Description IS NOT NULL'),
    updateTagType: db.prepare('UPDATE Ios SET TagType = ? WHERE id = ?'),
    updateProjectName: db.prepare('UPDATE Projects SET Name = ? WHERE id = (SELECT ProjectId FROM Subsystems WHERE id = ?)'),
    updateSubsystemName: db.prepare('UPDATE Subsystems SET Name = ? WHERE id = ?'),
    // Network/e-stop/safety/punchlist statements were removed here (F1):
    // those sections are now rewritten by runConfigSidePulls, which owns its
    // own scoped, success-gated delete+reinsert statements.
    insertL2Sheet: db.prepare('INSERT INTO L2Sheets (CloudId, Name, DisplayName, DisplayOrder, Discipline, DeviceCount) VALUES (?, ?, ?, ?, ?, ?)'),
    insertL2Col: db.prepare('INSERT INTO L2Columns (CloudId, SheetId, Name, ColumnType, InputType, DisplayOrder, IsSystem, IsEditable, IncludeInProgress, IsRequired, Description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insertL2Dev: db.prepare('INSERT INTO L2Devices (CloudId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder, CompletedChecks, TotalChecks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    insertL2Cell: db.prepare('INSERT OR REPLACE INTO L2CellValues (CloudCellId, DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  }
}

function describeFetchError(err: unknown): string {
  if (!err) return 'unknown error'
  if (!(err instanceof Error)) return String(err)
  const cause = (err as any).cause
  if (cause) {
    const code = cause.code || cause.errno
    const causeMsg = cause.message || String(cause)
    return code ? `${err.message} (${code}: ${causeMsg})` : `${err.message} (${causeMsg})`
  }
  return err.message
}

function classifyDescription(desc: string | null): string | null {
  if (!desc) return null
  const dl = desc.toLowerCase()
  if (dl.includes('beacon')) return 'BCN 24V Segment 1'
  if (dl.includes('pushbutton light') || dl.includes('pb_lt') || dl.includes('pblt') || (dl.includes('button') && dl.includes('light')))
    return 'Button Light'
  if (dl.includes('pushbutton') || dl.includes('push button'))
    return 'Button Press'
  if (dl.includes('photoeye') || dl.includes('tpe'))
    return 'TPE Dark Operated'
  if (dl.includes('vfd') || dl.includes('motor'))
    return 'Motor/VFD'
  if (dl.includes('disconnect'))
    return 'Disconnect Switch'
  if (dl.includes('light') || dl.includes('lamp') || dl.includes('indicator'))
    return 'Indicator Light'
  if (dl.includes('sensor') || dl.includes('prox'))
    return 'Sensor'
  if (dl.includes('valve') || dl.includes('solenoid'))
    return 'Valve/Solenoid'
  if (dl.includes('safety') || dl.includes('e-stop') || dl.includes('estop'))
    return 'Safety Device'
  return null
}

/**
 * POST /api/cloud/pull
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = req.body
    const { remoteUrl, apiPassword } = body
    const subsystemId = typeof body.subsystemId === 'string'
      ? parseInt(body.subsystemId, 10)
      : body.subsystemId

    if (!remoteUrl) {
      return res.status(400).json({ success: false, error: 'Remote URL is required' } as CloudPullResponse)
    }

    if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
      return res.status(400).json({ success: false, error: 'Valid subsystem ID is required' } as CloudPullResponse)
    }

    // ── Multi-MCM fence (2026-07-03 sync audit, F1) ─────────────────────
    // This legacy route is GLOBALLY destructive: DELETE FROM Ios with no
    // WHERE plus a whole-table stale-config cleanup. That is correct ONLY on
    // a single-MCM field tablet, where the entire local DB belongs to the
    // one active subsystem (the subsystem-switch flow relies on it). On a
    // central / multi-MCM deployment the same wipe destroys every other
    // MCM's IOs, FV, safety and e-stop data (the MCM17 incident class).
    // Refuse and point at the scoped per-MCM pull.
    try {
      const cfg = await configService.getConfig()
      const mcmCount = cfg.mcms?.length ?? 0
      if (cfg.mcmsExplicit || mcmCount > 1) {
        return res.status(409).json({
          success: false,
          error:
            `Global pull refused: this is a multi-MCM deployment (${mcmCount} MCM(s) configured). ` +
            'The legacy full pull wipes ALL MCMs\' local data. Use the scoped per-MCM pull ' +
            `(POST /api/mcm/${subsystemId}/pull) or the MCM page's Pull button instead.`,
        } as CloudPullResponse)
      }
    } catch {
      // Config unreadable → assume legacy single-MCM tablet and continue.
    }

    // Refuse to pull while the PLC is connected. A pull rewrites the Ios
    // table; live tag handles in the PlcClient point at row IDs that would
    // shift mid-pull, and the tag reader keeps emitting state changes for
    // the OLD subsystem onto rows that now belong to a NEW one. The safe
    // sequence is always: Disconnect → Pull → Connect. The dialog's
    // Subsystem-switch button orchestrates this, but the server still
    // enforces it so manual API calls / future UIs can't sneak past.
    try {
      const client = getPlcClient()
      if (client.isConnected) {
        return res.status(409).json({
          success: false,
          error: 'Disconnect the PLC before pulling IOs. The PLC is still connected — switching IO definitions while connected can corrupt live tag state.',
        } as CloudPullResponse)
      }
    } catch {
      // If the client singleton isn't initialized yet, fall through —
      // there's no live connection to protect.
    }

    console.log(`[CloudPull] Starting pull for subsystem ${subsystemId} from ${remoteUrl}`)
    console.log(`[CloudPull] API Password provided: ${apiPassword ? 'yes (' + apiPassword.length + ' chars)' : 'no'}`)

    // Split the IO queue: ACTIVE rows can still sync; PARKED rows (DeadLettered=1)
    // are writes the cloud permanently rejected — they will NEVER sync, so telling
    // the user to "sync them first" is impossible. Both still BLOCK this DESTRUCTIVE
    // pull (it overwrites local; a backup is taken first), but the guidance differs:
    // sync the active ones, RESOLVE the parked ones.
    const pendingIoActive = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE DeadLettered = 0').get() as { cnt: number }).cnt
    const pendingIoParked = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE DeadLettered = 1').get() as { cnt: number }).cnt
    const pendingL2Count = (getPullStmts().pendingL2Count.get() as { cnt: number }).cnt
    const pendingChangeRequestCount = (getPullStmts().pendingChangeRequestCount.get() as { cnt: number }).cnt
    // E-stop EPC checks and guided-task overrides have their own offline push
    // queues. The destructive pull below DELETEs EStopZones/EStopEpcs (which
    // cascades E-stop check data) and rewrites the IO/guided state, so an
    // unsynced row in either queue is at risk too — block on them exactly like
    // IO/L2. (These queues carry no DeadLettered concept; any row blocks.)
    const pendingEStopCheckCount = (getPullStmts().pendingEStopCheckCount.get() as { cnt: number }).cnt
    const pendingGuidedTaskCount = (getPullStmts().pendingGuidedTaskCount.get() as { cnt: number }).cnt
    const totalPendingCount = pendingIoActive + pendingIoParked + pendingL2Count + pendingChangeRequestCount + pendingEStopCheckCount + pendingGuidedTaskCount
    if (totalPendingCount > 0) {
      const syncable = [
        pendingIoActive > 0 ? `${pendingIoActive} IO test change(s)` : null,
        pendingL2Count > 0 ? `${pendingL2Count} L2 cell change(s)` : null,
        pendingChangeRequestCount > 0 ? `${pendingChangeRequestCount} change request(s)` : null,
        pendingEStopCheckCount > 0 ? `${pendingEStopCheckCount} E-stop check result(s)` : null,
        pendingGuidedTaskCount > 0 ? `${pendingGuidedTaskCount} guided-task update(s)` : null,
      ].filter(Boolean).join(', ')

      const parts: string[] = []
      if (syncable) parts.push(`sync ${syncable} first`)
      if (pendingIoParked > 0) {
        parts.push(
          `resolve ${pendingIoParked} flagged row(s) the cloud rejected ` +
          `(re-pass/fail/clear or accept in the grid — these cannot be synced)`
        )
      }

      return res.status(409).json({
        success: false,
        error: `Pull blocked to protect unsynced local data: ${parts.join('; ')}.`
      } as CloudPullResponse)
    }

    // B6: the pull below is DESTRUCTIVE (DELETE FROM Ios + reinsert cloud
    // state). The pre-pull backup is the last line of recovery. If it fails,
    // ABORT — proceeding with a wipe and no backup is how unsynced field work
    // becomes unrecoverable. (Was: failure logged and the wipe continued.)
    try {
      const backup = await createBackup('pre-pull')
      console.log(`[CloudPull] Auto-backup created: ${backup.filename}`)
    } catch (backupErr) {
      console.error('[CloudPull] Pre-pull backup FAILED — aborting pull to protect local data:', backupErr)
      return res.status(500).json({
        success: false,
        error:
          'Pre-pull safety backup failed, so the pull was aborted to protect your local data. ' +
          'A destructive pull without a backup risks unrecoverable loss of unsynced results. ' +
          'Check disk space / backups folder permissions and try again.',
      } as CloudPullResponse)
    }

    const cloudUrl = `${remoteUrl}/api/sync/subsystem/${subsystemId}`
    console.log(`[CloudPull] Fetching from: ${cloudUrl}`)

    let cloudResponse: globalThis.Response | null = null
    let lastFetchErr: unknown = null
    const MAX_ATTEMPTS = 4
    const baseHeaders = {
      'Content-Type': 'application/json',
      'X-API-Key': apiPassword || '',
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        cloudResponse = await fetch(cloudUrl, {
          method: 'GET',
          headers: baseHeaders,
          signal: AbortSignal.timeout(attempt === 1 ? 25000 : 30000),
        })
        if (attempt > 1) console.log(`[CloudPull] Attempt ${attempt}/${MAX_ATTEMPTS} succeeded`)
        break
      } catch (err) {
        lastFetchErr = err
        console.warn(`[CloudPull] Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${describeFetchError(err)}`)
        if (attempt === MAX_ATTEMPTS) break
        const backoffMs = 2000 * Math.pow(2, attempt - 1) // 2s, 4s, 8s
        await new Promise(r => setTimeout(r, backoffMs))
      }
    }

    if (!cloudResponse) {
      const msg = describeFetchError(lastFetchErr)
      const isTimeout = /TimeoutError|timed out|HEADERS_TIMEOUT|BODY_TIMEOUT/i.test(msg)
      const userMsg = isTimeout
        ? `Cloud server did not respond after ${MAX_ATTEMPTS} attempts. Check your network connection to ${remoteUrl}.`
        : `Cannot reach cloud server after ${MAX_ATTEMPTS} attempts: ${msg}. Check that the cloud URL is correct and your network connection is working.`
      return res.status(502).json({ success: false, error: userMsg } as CloudPullResponse)
    }

    console.log(`[CloudPull] Cloud response status: ${cloudResponse.status}`)

    if (cloudResponse.status === 401) {
      return res.status(403).json({ success: false, error: 'Cloud authentication failed - check API password' } as CloudPullResponse)
    }

    if (cloudResponse.status === 403) {
      const errorText = await cloudResponse.text()
      console.log(`[CloudPull] Cloud error: ${errorText}`)
      return res.status(403).json({
        success: false,
        error: `API password is not authorized for subsystem ${subsystemId}. This usually means the subsystem belongs to a different cloud project.`
      } as CloudPullResponse)
    }

    if (!cloudResponse.ok) {
      const errorText = await cloudResponse.text()
      console.log(`[CloudPull] Cloud error: ${errorText}`)
      return res.status(502).json({ success: false, error: `Cloud server error: ${cloudResponse.status}` } as CloudPullResponse)
    }

    const cloudData = await cloudResponse.json()
    console.log(`[CloudPull] Cloud response keys: ${Object.keys(cloudData)}`)

    const cloudIos = cloudData.ios || cloudData.Ios || []
    console.log(`[CloudPull] IOs extracted: ${cloudIos.length}`)

    if (!cloudIos || cloudIos.length === 0) {
      return res.json({
        success: true,
        message: `No IOs found for subsystem ${subsystemId}`,
        iosCount: 0,
        ioCount: 0,
        debug: {
          apiPasswordProvided: !!apiPassword,
          apiPasswordLength: apiPassword?.length || 0,
          cloudStatus: cloudResponse.status,
          cloudResponseKeys: Object.keys(cloudData),
        }
      })
    }

    console.log(`[CloudPull] Retrieved ${cloudIos.length} IOs from cloud, upserting to local database...`)

    // ── Result-loss guard (2026-06-04 TPA8/MCM08 incident) ────────────────
    // The pull below is destructive (DELETE FROM Ios + reinsert cloud state).
    // The pending-queue check above is the first line of defense, but it
    // failed catastrophically when the retry cap silently emptied the queue
    // while the site was offline: the guard saw 0 pending and let the pull
    // erase 818 unsynced results. This second guard doesn't trust the queue
    // at all — it compares actual local results against the actual cloud
    // payload, and refuses when the pull would erase results the cloud
    // doesn't have. The user can override with body.force === true after an
    // explicit confirmation in the UI.
    const localWithResults = db.prepare(
      `SELECT id, Name, Result, Timestamp FROM Ios WHERE Result IS NOT NULL AND Result != ''`
    ).all() as Array<{ id: number; Name: string; Result: string; Timestamp: string | null }>
    const atRisk = computeAtRiskResults(localWithResults, cloudIos)
    // B2: also detect local COMMENTS the pull would erase (the wipe drops them
    // too, and the old warning never mentioned them).
    const localWithComments = db.prepare(
      `SELECT id, Name, Comments FROM Ios WHERE Comments IS NOT NULL AND TRIM(Comments) != ''`
    ).all() as Array<{ id: number; Name: string; Comments: string }>
    const atRiskComments = computeAtRiskComments(localWithComments, cloudIos)
    // F2 (2026-07-03 audit): third check — a local result that DIFFERS from a
    // stale cloud value with no queue row left (retry-cap-emptied queue) is
    // also unsynced field work; only a provably-newer cloud value wins freely.
    const queuedIoIds = new Set(
      (db.prepare('SELECT IoId FROM PendingSyncs').all() as Array<{ IoId: number }>).map(r => r.IoId)
    )
    const divergent = computeDivergentUnqueuedResults(localWithResults, cloudIos, queuedIoIds)

    if ((atRisk.length > 0 || atRiskComments.length > 0 || divergent.length > 0) && body.force !== true) {
      console.warn(
        `[CloudPull] REFUSED: pull would erase ${atRisk.length} local result(s), ` +
        `${atRiskComments.length} local comment(s) the cloud does not have, and overwrite ` +
        `${divergent.length} newer local result(s) that differ from stale cloud values ` +
        `(e.g. ${[...atRisk, ...divergent].slice(0, 5).map(r => r.name).join(', ')}). ` +
        `Resend with force=true to override.`
      )
      const parts = [
        atRisk.length > 0 ? `${atRisk.length} test result(s) the cloud lacks` : null,
        atRiskComments.length > 0 ? `${atRiskComments.length} comment(s) the cloud lacks` : null,
        divergent.length > 0 ? `${divergent.length} newer local result(s) that differ from stale cloud values` : null,
      ].filter(Boolean).join(', ')
      return res.status(409).json({
        success: false,
        requiresForce: true,
        wouldLoseResults: atRisk.length,
        wouldLoseComments: atRiskComments.length,
        wouldOverwriteNewerLocal: divergent.length,
        atRiskSample: atRisk.slice(0, 10),
        atRiskCommentSample: atRiskComments.slice(0, 10),
        divergentSample: divergent.slice(0, 10),
        error:
          `Pull refused: ${parts} — pulling now would erase them. ` +
          `They are likely unsynced field work. ` +
          `Sync first, or confirm the overwrite to proceed. (A pre-pull backup is taken regardless.)`,
      } as CloudPullResponse)
    }
    if (atRisk.length > 0 || atRiskComments.length > 0 || divergent.length > 0) {
      console.warn(`[CloudPull] FORCE override: erasing ${atRisk.length} result(s) + ${atRiskComments.length} comment(s) + overwriting ${divergent.length} newer divergent result(s) (user confirmed)`)
    }

    const localCountRow = getPullStmts().ioCount.get() as { cnt: number }
    const localIoCount = localCountRow.cnt
    let pullWarning: string | undefined
    if (localIoCount > 0 && cloudIos.length < localIoCount) {
      const reduction = ((localIoCount - cloudIos.length) / localIoCount) * 100
      if (reduction > 50) {
        pullWarning = `Cloud returned ${cloudIos.length} IOs but local has ${localIoCount} (${reduction.toFixed(0)}% fewer). Proceeding as requested.`
        console.warn(`[CloudPull] WARNING: ${pullWarning}`)
      }
    }

    const result = db.transaction(() => {
      const existingProject = getPullStmts().getProject.get(1)
      if (!existingProject) {
        getPullStmts().insertProject.run(1, 'Default Project')
      }

      const existingSubsystem = getPullStmts().getSubsystem.get(subsystemId)
      if (!existingSubsystem) {
        getPullStmts().insertSubsystem.run(subsystemId, 1, `Subsystem ${subsystemId}`)
      }
      console.log(`[CloudPull] Ensured subsystem ${subsystemId} exists`)

      const beforeCount = (getPullStmts().ioCount.get() as any).cnt
      const deleteResult = getPullStmts().deleteAllIos.run()
      console.log(`[CloudPull] DELETE FROM Ios: had ${beforeCount}, deleted ${deleteResult.changes}`)
      const afterCount = (getPullStmts().ioCount.get() as any).cnt
      console.log(`[CloudPull] After delete: ${afterCount} IOs remaining`)
      // F1 (2026-07-03 audit): config sections (network/e-stop/safety/
      // punchlists) are NO LONGER deleted here. The old pattern deleted them
      // inside this transaction and re-inserted them only if the later cloud
      // fetch succeeded — any mid-pull network failure left the section EMPTY
      // (silent config loss). They are now rewritten by runConfigSidePulls
      // below: each section does its own scoped delete+reinsert ONLY after
      // its fetch succeeds (the same shared code path as the per-MCM pull).
      // Here we only clean up rows belonging to a DIFFERENT subsystem (stale
      // after a tablet subsystem switch) — the multi-MCM fence above
      // guarantees this box is single-MCM, so anything not belonging to the
      // target subsystem is a leftover tenant.
      const cleanupStale = (sql: string) => db.prepare(sql).run(subsystemId)
      cleanupStale('DELETE FROM EStopIoPoints WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId != ?))')
      cleanupStale('DELETE FROM EStopVfds WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId != ?))')
      cleanupStale('DELETE FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId != ?)')
      cleanupStale('DELETE FROM EStopZones WHERE SubsystemId != ?')
      cleanupStale('DELETE FROM SafetyZoneDrives WHERE ZoneId IN (SELECT id FROM SafetyZones WHERE SubsystemId != ?)')
      cleanupStale('DELETE FROM SafetyZones WHERE SubsystemId != ?')
      cleanupStale('DELETE FROM SafetyOutputs WHERE SubsystemId != ?')
      cleanupStale('DELETE FROM NetworkPorts WHERE NodeId IN (SELECT id FROM NetworkNodes WHERE RingId IN (SELECT id FROM NetworkRings WHERE SubsystemId != ?))')
      cleanupStale('DELETE FROM NetworkNodes WHERE RingId IN (SELECT id FROM NetworkRings WHERE SubsystemId != ?)')
      cleanupStale('DELETE FROM NetworkRings WHERE SubsystemId != ?')
      cleanupStale('DELETE FROM PunchlistItems WHERE PunchlistId IN (SELECT id FROM Punchlists WHERE SubsystemId != ?)')
      cleanupStale('DELETE FROM Punchlists WHERE SubsystemId != ?')
      // NOTE: L2 data is NOT deleted here — it's only cleared when fresh L2 data
      // is successfully fetched from cloud (see L2 pull section below).
      // This prevents losing FV data if the L2 pull fails.
      console.log('[CloudPull] Cleaned up stale other-subsystem config rows (target subsystem config is rewritten by side-pulls after fetch success)')

      const upsertStmt = getPullStmts().upsertIo
      let upsertedCount = 0

      for (const cloudIo of cloudIos) {
        if (!cloudIo.name || cloudIo.id <= 0) {
          console.warn(`[CloudPull] Skipping invalid IO: id=${cloudIo.id}, name=${cloudIo.name}`)
          continue
        }

        try {
          upsertStmt.run({
            id: cloudIo.id,
            Name: cloudIo.name,
            Description: cloudIo.description ?? null,
            SubsystemId: subsystemId,
            Result: cloudIo.result ?? null,
            Comments: cloudIo.comments ?? null,
            Timestamp: cloudIo.timestamp ?? null,
            TestedBy: cloudIo.testedBy ?? null,
            IoNumber: cloudIo.order ?? null,
            InstallationStatus: cloudIo.installationStatus ?? null,
            InstallationPercent: cloudIo.installationPercent ?? null,
            PoweredUp: cloudIo.poweredUp === true ? 1 : cloudIo.poweredUp === false ? 0 : null,
            TagType: cloudIo.tagType ?? null,
            Version: Number(cloudIo.version) || 0,
            Trade: cloudIo.trade ?? null,
            ClarificationNote: cloudIo.clarificationNote ?? null,
            NetworkDeviceName: cloudIo.networkDeviceName ?? null,
            PunchlistStatus: cloudIo.punchlistStatus ?? null,
            CloudSyncedAt: new Date().toISOString(),
            Order: cloudIo.order ?? null,
          })
          upsertedCount++
        } catch (error) {
          console.error(`[CloudPull] Failed to upsert IO ${cloudIo.id}:`, error)
        }
      }

      const iosWithoutDevice = getPullStmts().getIosWithoutDevice.all() as { id: number; Name: string }[]
      const updateDeviceStmt = getPullStmts().updateDeviceName
      for (const io of iosWithoutDevice) {
        const deviceName = extractDeviceName(io.Name)
        if (deviceName) {
          updateDeviceStmt.run(deviceName, io.id)
        }
      }

      return upsertedCount
    })()

    console.log(`[CloudPull] Successfully upserted ${result} IOs to local database`)

    const cloudHistories = cloudData.testHistories || []
    let historiesPulled = 0
    if (cloudHistories.length > 0) {
      try {
        db.transaction(() => {
          getPullStmts().deleteHistories.run()
          const insertHistoryStmt = getPullStmts().insertHistory

          for (const h of cloudHistories) {
            if (!h.ioId || !h.timestamp) continue
            try {
              insertHistoryStmt.run(
                h.ioId,
                h.result ?? null,
                h.testedBy ?? null,
                h.comments ?? null,
                h.failureMode ?? null,
                h.state ?? null,
                h.timestamp,
                h.source ?? 'cloud',
              )
              historiesPulled++
            } catch {
              // Skip individual history records that fail
            }
          }
        })()
        console.log(`[CloudPull] Pulled ${historiesPulled} test history records from cloud`)
      } catch (e) {
        console.error('[CloudPull] Test history pull failed:', e)
      }
    }

    try {
      const untyped = getPullStmts().getUntypedIos.all() as { id: number; Description: string | null }[]
      let assigned = 0
      const updateTagTypeStmt = getPullStmts().updateTagType
      for (const io of untyped) {
        const tagType = classifyDescription(io.Description)
        if (tagType) {
          updateTagTypeStmt.run(tagType, io.id)
          assigned++
        }
      }
      if (assigned > 0) {
        console.log(`[CloudPull] Auto-assigned tagType to ${assigned} IOs based on descriptions`)
      }
    } catch (error) {
      console.error('[CloudPull] Error assigning tag types:', error)
    }

    try {
      const { configService } = await import('@/lib/config')
      await configService.saveConfig({
        remoteUrl: remoteUrl,
        apiPassword: apiPassword,
        subsystemId: String(subsystemId),
      })
      console.log('[CloudPull] Cloud config saved to config.json')
    } catch (e) {
      console.warn('[CloudPull] Failed to save config:', e)
    }

    try {
      const infoUrl = `${remoteUrl}/api/sync/subsystem-info/${subsystemId}`
      const infoRes = await fetch(infoUrl, {
        headers: { 'X-API-Key': apiPassword || '' },
        signal: AbortSignal.timeout(10000),
      })
      if (infoRes.ok) {
        const info = await infoRes.json()
        if (info.projectName) {
          getPullStmts().updateProjectName.run(info.projectName, subsystemId)
        }
        if (info.subsystemName) {
          getPullStmts().updateSubsystemName.run(info.subsystemName, subsystemId)
        }
        console.log(`[CloudPull] Updated names: ${info.projectName} / ${info.subsystemName}`)
      }
    } catch (e) {
      // Non-critical
    }

    try {
      const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
      const syncService = getCloudSyncService()
      syncService.setConnectionState('connected')
    } catch (e) {
      console.warn('[CloudPull] Failed to update sync service state:', e)
    }

    try {
      const { startAutoSync, getAutoSyncService } = await import('@/lib/cloud/auto-sync')
      const service = getAutoSyncService()
      if (service) {
        service.markManualPull()
      }
      if (!service?.running) {
        startAutoSync()
        console.log('[CloudPull] Auto-sync started after successful pull')
      }
    } catch (e) {
      console.warn('[CloudPull] Failed to start auto-sync:', e)
    }

    console.log('[CloudPull] Broadcasting IO update to WebSocket clients...')
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'IOsUpdated', count: result }),
        signal: AbortSignal.timeout(5000),
      })
      console.log('[CloudPull] Broadcast sent')
    } catch (e) {
      console.log('[CloudPull] Broadcast skipped:', (e as Error).message)
    }

    // F1 (2026-07-03 audit): network / e-stop / safety / punchlists now come
    // from the SAME success-gated, subsystem-scoped delete+reinsert helper the
    // per-MCM pull uses. A failed/empty fetch keeps the existing local rows
    // instead of leaving a section that the old in-transaction delete had
    // already emptied.
    console.log('[CloudPull] Running config side-pulls (network/estop/safety/punchlists)...')
    const sidePulls = await runConfigSidePulls(subsystemId, remoteUrl, apiPassword || '', { db })
    const networkPulled = sidePulls.networkPulled
    const estopPulled = sidePulls.estopPulled
    const safetyPulled = sidePulls.safetyPulled
    const punchlistsPulled = sidePulls.punchlistsPulled
    console.log(`[CloudPull] Side-pulls done: network=${networkPulled}, estop=${estopPulled}, safety=${safetyPulled}, punchlists=${punchlistsPulled}`)

    // Pull L2 (Functional Validation) data via the SCOPED /api/cloud/pull-l2
    // route. The old inline block here ran `DELETE FROM L2CellValues` (and
    // L2Devices/Columns/Sheets) UNSCOPED — wiping EVERY MCM's local FV — and
    // re-inserted devices with no SubsystemId. On a multi-MCM/server laptop a
    // single "Pull" therefore destroyed other MCMs' functional-validation work.
    // pull-l2 deletes ONLY this subsystem's cells/devices, stamps SubsystemId,
    // takes its own pre-pull backup, and triggers the VFD flag sync — one
    // correct L2 code path shared with the per-MCM pull. Best-effort: an L2
    // failure is surfaced via l2Error but never aborts the IO pull.
    let l2Pulled = 0
    let l2CellsPulled = 0
    let l2Error: string | null = null
    try {
      const port = process.env.PORT || '3000'
      const l2Res = await fetch(`http://127.0.0.1:${port}/api/cloud/pull-l2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Propagate force: an operator who explicitly confirmed the at-risk
        // overwrite shouldn't have the L2 leg refused by its own FV guard.
        body: JSON.stringify({ remoteUrl, apiPassword, subsystemId, force: body.force === true }),
        signal: AbortSignal.timeout(60_000),
      })
      const l2Data = await l2Res.json().catch(() => ({} as { success?: boolean; error?: string; l2Pulled?: number; l2CellsPulled?: number }))
      if (!l2Res.ok || l2Data.success === false) {
        l2Error = l2Data.error || `L2 pull HTTP ${l2Res.status}`
        console.error(`[CloudPull] L2/FV pull failed: ${l2Error}`)
      } else {
        l2Pulled = l2Data.l2Pulled || 0
        l2CellsPulled = l2Data.l2CellsPulled || 0
        console.log(`[CloudPull] L2 PULL SUCCESS (scoped to subsystem ${subsystemId}): ${l2Pulled} devices, ${l2CellsPulled} cells`)
      }
    } catch (e) {
      l2Error = e instanceof Error ? e.message : String(e)
      console.error('[CloudPull] L2/FV pull EXCEPTION:', l2Error)
    }

    // Durable recovery-log trace of this DESTRUCTIVE pull (F1: the legacy
    // route previously left NO recovery-log record of a global wipe).
    auditLog({
      type: 'sync.pull',
      subsystemId,
      detail: {
        route: 'legacy-full-pull',
        destructive: true,
        force: body.force === true,
        iosCount: result,
        historiesPulled,
        networkPulled,
        estopPulled,
        safetyPulled,
        punchlistsPulled,
        l2Pulled,
        l2CellsPulled,
        overrodeAtRiskResults: atRisk.length,
        overrodeAtRiskComments: atRiskComments.length,
        overrodeDivergentNewer: divergent.length,
      },
    })

    return res.json({
      success: true,
      message: `Successfully pulled ${result} IOs from cloud`,
      iosCount: result,
      ioCount: result,
      networkPulled,
      estopPulled,
      safetyPulled,
      punchlistsPulled,
      l2Pulled,
      l2CellsPulled,
      historiesPulled,
      ...(l2Error ? { l2Error } : {}),
      ...(pullWarning ? { warning: pullWarning } : {}),
      debug: {
        cloudIosLength: cloudIos.length,
        cloudResponseKeys: Object.keys(cloudData),
        firstIoId: cloudIos[0]?.id,
        firstIoName: cloudIos[0]?.name,
      }
    })
  } catch (error) {
    console.error('[CloudPull] Error pulling IOs from cloud:', error)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

    if (errorMessage.includes('Authentication failed') || errorMessage.includes('401')) {
      return res.status(403).json({ success: false, error: 'Cloud authentication failed - check API password' } as CloudPullResponse)
    }

    return res.status(500).json({ success: false, error: errorMessage } as CloudPullResponse)
  }
}
