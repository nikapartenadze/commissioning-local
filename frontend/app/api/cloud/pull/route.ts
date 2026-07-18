import { Request, Response } from 'express'
import { db, extractDeviceName } from '@/lib/db-sqlite'
import { getWsBroadcastUrl, getPlcClient } from '@/lib/plc-client-manager'
import { createBackup } from '@/lib/db/backup'
import { runFullPull } from '@/lib/cloud/pull-core'
import { pullExtraSections } from '@/lib/cloud/pull-extra-sections'
import { auditLog } from '@/lib/logging/recovery-log'
import { mcmTag } from '@/lib/logging/mcm-tag'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types'
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

/**
 * L2/FV self-call — POSTs to the scoped /api/cloud/pull-l2 route (its own scoped
 * delete+insert + FV risk guard). Best-effort: an L2 failure is surfaced via
 * l2Error but never aborts the IO pull. Passed into runFullPull as deps.pullL2.
 */
async function pullL2SelfCall(
  subsystemId: number,
  remoteUrl: string,
  apiPassword: string,
  force: boolean,
): Promise<{ l2Pulled: number; l2CellsPulled: number; l2Error: string | null }> {
  try {
    const port = process.env.PORT || '3000'
    const l2Res = await fetch(`http://127.0.0.1:${port}/api/cloud/pull-l2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Propagate force: an operator who explicitly confirmed the at-risk
      // overwrite shouldn't have the L2 leg refused by its own FV guard.
      body: JSON.stringify({ remoteUrl, apiPassword, subsystemId, force }),
      signal: AbortSignal.timeout(60_000),
    })
    const l2Data = await l2Res.json().catch(() => ({} as { success?: boolean; error?: string; l2Pulled?: number; l2CellsPulled?: number }))
    if (!l2Res.ok || l2Data.success === false) {
      return { l2Pulled: 0, l2CellsPulled: 0, l2Error: l2Data.error || `L2 pull HTTP ${l2Res.status}` }
    }
    return { l2Pulled: l2Data.l2Pulled || 0, l2CellsPulled: l2Data.l2CellsPulled || 0, l2Error: null }
  } catch (e) {
    return { l2Pulled: 0, l2CellsPulled: 0, l2Error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * POST /api/cloud/pull
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = req.body
    // Resolve cloud creds SERVER-side. Since the API key is no longer sent to
    // the browser (/api/plc/status now returns apiKeySet, not the key), the
    // dialog can call this route with just { subsystemId } and we fall back to
    // the saved config. The body is still honored when present so a legacy
    // caller — or an operator pulling a DIFFERENT project — can override.
    // Config-read failure is tolerated (assume a legacy single-MCM tablet).
    let cfg: Awaited<ReturnType<typeof configService.getConfig>> | null = null
    try { cfg = await configService.getConfig() } catch { /* use body creds / embedded */ }
    const remoteUrl = body.remoteUrl || cfg?.remoteUrl || EMBEDDED_REMOTE_URL || ''
    const apiPassword = body.apiPassword || cfg?.apiPassword || ''
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
    {
      const mcmCount = cfg?.mcms?.length ?? 0
      if (cfg?.mcmsExplicit || mcmCount > 1) {
        return res.status(409).json({
          success: false,
          error:
            `Global pull refused: this is a multi-MCM deployment (${mcmCount} MCM(s) configured). ` +
            'The legacy full pull wipes ALL MCMs\' local data. Use the scoped per-MCM pull ' +
            `(POST /api/mcm/${subsystemId}/pull) or the MCM page's Pull button instead.`,
        } as CloudPullResponse)
      }
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

    console.log(`${mcmTag(subsystemId)}[CloudPull] Starting pull for subsystem ${subsystemId} from ${remoteUrl}`)
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

    // ── Destructive core (SHARED with the per-MCM pull) ───────────────────
    // The risk guard → pre-pull backup → scope-correct DELETE+upsert →
    // TestHistories → tagType backfill → >50% warning → side-pulls + L2 all live
    // in lib/cloud/pull-core.ts so the two routes can no longer drift (the scoped
    // route used to silently LACK TestHistories/tagType/>50%). `global: true`
    // selects the legacy single-MCM behavior: UNSCOPED `DELETE FROM Ios` + the
    // other-subsystem stale-config cleanup, and whole-table guard/history/backfill
    // queries. The multi-MCM fence above guarantees this box is single-MCM.
    const cloudHistories = cloudData.testHistories || []
    const pull = await runFullPull({
      db,
      subsystemId,
      global: true,
      cloudIos,
      cloudHistories,
      remoteUrl,
      apiPassword: apiPassword || '',
      force: body.force === true,
      logPrefix: `${mcmTag(subsystemId)}[CloudPull]`,
      deps: { createBackup, extractDeviceName, pullL2: pullL2SelfCall },
    })

    if (pull.kind !== 'ok') {
      if (pull.kind === 'refuse') {
        return res.status(pull.status).json(pull.body)
      }
      if (pull.kind === 'backup-failed') {
        return res.status(500).json({
          success: false,
          error:
            'Pre-pull safety backup failed, so the pull was aborted to protect your local data. ' +
            'A destructive pull without a backup risks unrecoverable loss of unsynced results. ' +
            'Check disk space / backups folder permissions and try again.',
        } as CloudPullResponse)
      }
      // 'pending-appeared' cannot arise on the global path (no TOCTOU re-check),
      // but keep the union exhaustive.
      return res.status(409).json({
        success: false,
        error: 'Pull skipped — local test activity was detected during the pull. Local data is preserved.',
      } as CloudPullResponse)
    }

    const result = pull.iosCount
    const {
      historiesPulled, networkPulled, estopPulled, safetyPulled, punchlistsPulled,
      l2Pulled, l2CellsPulled, l2Error, pullWarning,
    } = pull
    // Sections runConfigSidePulls / L2 don't cover (VFD blockers/addressed,
    // roadmap, MCM diagram) — refresh them so one manual pull is complete.
    const extra = await pullExtraSections(subsystemId, remoteUrl, apiPassword)
    console.log(`[CloudPull] Side-pulls done: network=${networkPulled}, estop=${estopPulled}, safety=${safetyPulled}, punchlists=${punchlistsPulled}`)
    if (l2Error) console.error(`[CloudPull] L2/FV pull failed: ${l2Error}`)

    // ── Legacy single-MCM tail (NOT part of the shared body) ──────────────
    // Persist the cloud creds + subsystem so a legacy single-MCM tablet reopens
    // on the same subsystem. The scoped route intentionally does NOT do this.
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
        overrodeAtRiskResults: pull.atRisk.length,
        overrodeAtRiskComments: pull.atRiskComments.length,
        overrodeDivergentNewer: pull.divergent.length,
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
      ...extra,
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
