/**
 * Shared destructive-pull body for the field tool's two full-pull routes.
 *
 * Both /api/cloud/pull (legacy GLOBAL, single-MCM tablets) and
 * /api/mcm/[subsystemId]/pull (per-MCM scoped) used to carry their own copy of
 * the destructive DELETE+reinsert. They drifted: the scoped route silently
 * LACKED the TestHistories sync, the classifyDescription tagType backfill, and
 * the ">50% fewer IOs" safety warning that the legacy route had — so which
 * button you pressed changed whether those happened. This module is the single
 * body both call, so the behavior can no longer diverge.
 *
 * It runs, in order:
 *   1. the result-loss risk guard (computePullRiskOrRefuse)
 *   2. the pre-pull safety backup (mandatory; abort on failure)
 *   3. the scope-correct DELETE + upsert of Ios (in one transaction)
 *   4. the TestHistories sync
 *   5. the classifyDescription tagType backfill
 *   6. the >50%-fewer-IOs warning
 *   7. the config side-pulls (runConfigSidePulls) + the L2/FV self-call
 *
 * SCOPE is driven by `global`:
 *   - global === true  → legacy single-MCM tablet. Ios delete is UNSCOPED
 *     (DELETE FROM Ios, no WHERE), other-subsystem config rows are cleaned up,
 *     TestHistories delete is unscoped, and the untyped/backfill/count queries
 *     scan the whole table. The guard runs with subsystemId=null.
 *   - global === false → per-MCM. Ios delete is `WHERE SubsystemId = ?`, a
 *     TOCTOU re-check of the pending queues runs INSIDE the transaction, and
 *     TestHistories / backfill / count queries are all scoped to the subsystem.
 *     The guard runs with the concrete subsystemId.
 *
 * `subsystemId` is ALWAYS the concrete target subsystem (rows are always
 * upserted with SubsystemId = subsystemId and the side-pulls are always scoped
 * to it) — `global` only controls the DELETE breadth and query filters, exactly
 * matching the two routes' prior behavior.
 *
 * The route keeps everything that is genuinely route-specific: the multi-MCM
 * fence, the PLC-connection guard, the pending-queue pre-check, the cloud fetch,
 * the no-op short-circuit (scoped), config-save / subsystem-info / markManualPull
 * (legacy), invalidateIoSubsystemCache / hash-store (scoped), the broadcast, and
 * the audit-log record. This body only owns the destructive core + the four
 * features that had drifted.
 */

import { runConfigSidePulls as realRunConfigSidePulls, type SidePullResult } from '@/lib/cloud/config-side-pulls'
import { computePullRiskOrRefuse, type AtRiskResult, type AtRiskComment, type DivergentUnqueuedResult, type AtRiskClear } from '@/lib/cloud/pull-guard'

// ── Minimal better-sqlite3 surface (decoupled from db-sqlite so this module is
// unit-testable without booting the real DB, exactly like config-side-pulls). ──
interface Stmt {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint }
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
}
export interface PullCoreDb {
  prepare: (sql: string) => Stmt
  transaction: <T>(fn: () => T) => () => T
}

export interface CloudIo {
  id: number
  name?: string
  description?: string | null
  result?: string | null
  comments?: string | null
  timestamp?: string | null
  testedBy?: string | null
  order?: number | null
  installationStatus?: string | null
  installationPercent?: number | null
  poweredUp?: boolean | null
  tagType?: string | null
  version?: number | string | null
  trade?: string | null
  clarificationNote?: string | null
  networkDeviceName?: string | null
  punchlistStatus?: string | null
}

export interface CloudHistory {
  ioId?: number
  result?: string | null
  testedBy?: string | null
  comments?: string | null
  failureMode?: string | null
  state?: string | null
  timestamp?: string | null
  source?: string | null
}

export interface L2SelfCallResult {
  l2Pulled: number
  l2CellsPulled: number
  l2Error: string | null
}

export interface RunFullPullDeps {
  /** Full-DB pre-pull backup. Abort the pull if this throws. */
  createBackup: (label: string) => Promise<{ filename: string }>
  /** Tag-name → device-name extractor (from db-sqlite in the routes). */
  extractDeviceName: (tagName: string) => string | null
  /** L2/FV self-call (HTTP to /api/cloud/pull-l2 in the routes). */
  pullL2: (subsystemId: number, remoteUrl: string, apiPassword: string, force: boolean) => Promise<L2SelfCallResult>
  /** Injectable for tests; defaults to the real config side-pulls. */
  runConfigSidePulls?: (
    subsystemId: number,
    remoteUrl: string,
    apiPassword: string,
    deps: { db: unknown },
  ) => Promise<SidePullResult>
}

export interface RunFullPullParams {
  db: PullCoreDb
  /** Concrete target subsystem (rows are always upserted with this id). */
  subsystemId: number
  /** true → legacy unscoped global pull; false → per-MCM scoped pull. */
  global: boolean
  cloudIos: CloudIo[]
  cloudHistories: CloudHistory[]
  remoteUrl: string
  apiPassword: string
  force: boolean
  /** Scoped background catch-up pulls skip the backup when nothing is at risk. */
  isBackground?: boolean
  /** Name used when the Subsystems row must be created. */
  subsystemName?: string
  /** Console prefix, matching each route's existing log tag. */
  logPrefix: string
  deps: RunFullPullDeps
}

export type RunFullPullResult =
  // The result-loss guard refused (409); the caller returns status/body verbatim.
  | { ok: false; kind: 'refuse'; status: number; body: Record<string, unknown> }
  // Scoped TOCTOU re-check tripped: a test was recorded during the cloud fetch.
  | { ok: false; kind: 'pending-appeared' }
  // The mandatory pre-pull backup failed; nothing destructive ran.
  | { ok: false; kind: 'backup-failed' }
  | {
      ok: true
      kind: 'ok'
      iosCount: number
      historiesPulled: number
      networkPulled: number
      estopPulled: number
      safetyPulled: number
      punchlistsPulled: number
      l2Pulled: number
      l2CellsPulled: number
      l2Error: string | null
      pullWarning?: string
      atRisk: AtRiskResult[]
      atRiskComments: AtRiskComment[]
      divergent: DivergentUnqueuedResult[]
      atRiskClears: AtRiskClear[]
    }

/**
 * Sentinel thrown inside the scoped transaction when the pending re-check trips.
 * Kept as a plain Error message so the transaction rolls back atomically.
 */
const PENDING_APPEARED = 'PENDING_APPEARED'

const UPSERT_IO_SQL = `
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
`

/**
 * Description → tagType heuristic. Shared verbatim with the legacy route so the
 * scoped route now backfills tagType identically. Returns null when no rule
 * matches (the caller leaves the existing TagType untouched).
 */
export function classifyDescription(desc: string | null): string | null {
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
 * The destructive core shared by both full-pull routes. See the module header
 * for the scope contract. This function NEVER touches res/req — it returns a
 * discriminated result the caller maps onto the HTTP response.
 */
export async function runFullPull(params: RunFullPullParams): Promise<RunFullPullResult> {
  const {
    db, subsystemId, global, cloudIos, cloudHistories,
    remoteUrl, apiPassword, force, isBackground = false,
    subsystemName, logPrefix, deps,
  } = params
  const doSidePulls = deps.runConfigSidePulls ?? realRunConfigSidePulls

  // ── 1. Result-loss risk guard ──────────────────────────────────────────────
  // Compares actual local results/comments/clears against the actual cloud
  // payload (never trusting the pending queue, which the retry cap can empty)
  // and refuses with a 409 unless `force`. subsystemId=null selects the legacy
  // global (unscoped) queries + generic message; a number selects scoped.
  const guard = computePullRiskOrRefuse(
    { db, subsystemId: global ? null : subsystemId, logPrefix },
    cloudIos,
    force,
  )
  if (guard.refuse) {
    return { ok: false, kind: 'refuse', status: guard.refuse.status, body: guard.refuse.body }
  }
  const { atRisk, atRiskComments, divergent, atRiskClears } = guard

  // ── 2. Pre-pull safety backup ──────────────────────────────────────────────
  // The rewrite below is DESTRUCTIVE — the backup is the last line of recovery.
  // Legacy (global) always backs up (isBackground is never set for it). Scoped
  // background catch-up pulls skip it ONLY when nothing is at risk; a forced
  // overwrite of at-risk data always backs up. Abort on failure — a wipe with no
  // backup is how unsynced field work becomes unrecoverable.
  const hasRisk = atRisk.length > 0 || atRiskComments.length > 0 || divergent.length > 0 || atRiskClears.length > 0
  const mustBackup = !isBackground || (force && hasRisk)
  if (mustBackup) {
    try {
      const backup = await deps.createBackup(global ? 'pre-pull' : `pre-pull-mcm${subsystemId}`)
      console.log(`${logPrefix} Auto-backup created: ${backup.filename}`)
    } catch (backupErr) {
      console.error(`${logPrefix} Pre-pull backup FAILED — aborting pull to protect local data:`, backupErr)
      return { ok: false, kind: 'backup-failed' }
    }
  }

  // ── >50%-fewer-IOs warning (measured BEFORE the delete) ─────────────────────
  const localIoCount = (
    global
      ? db.prepare('SELECT COUNT(*) as cnt FROM Ios').get()
      : db.prepare('SELECT COUNT(*) as cnt FROM Ios WHERE SubsystemId = ?').get(subsystemId)
  ) as { cnt: number }
  let pullWarning: string | undefined
  if (localIoCount.cnt > 0 && cloudIos.length < localIoCount.cnt) {
    const reduction = ((localIoCount.cnt - cloudIos.length) / localIoCount.cnt) * 100
    if (reduction > 50) {
      pullWarning = `Cloud returned ${cloudIos.length} IOs but local has ${localIoCount.cnt} (${reduction.toFixed(0)}% fewer). Proceeding as requested.`
      console.warn(`${logPrefix} WARNING: ${pullWarning}`)
    }
  }

  // ── 3. Scope-correct DELETE + upsert of Ios (one transaction) ───────────────
  const upsertStmt = db.prepare(UPSERT_IO_SQL)
  let iosCount: number
  try {
    iosCount = db.transaction(() => {
      // Scoped TOCTOU guard: the pending pre-check in the route ran BEFORE the
      // cloud fetch (an await). A test recorded during that fetch would slip past
      // it and then be clobbered by the DELETE below. Re-check synchronously,
      // atomically with the delete, and abort if one appeared. (Global/legacy
      // single-MCM boxes never had this re-check — preserved.)
      if (!global) {
        const pendingNow = (db
          .prepare(
            `SELECT COUNT(*) as cnt FROM PendingSyncs ps
             JOIN Ios i ON i.id = ps.IoId
             WHERE i.SubsystemId = ?`,
          )
          .get(subsystemId) as { cnt: number }).cnt
        const estopPendingNow = (db
          .prepare('SELECT COUNT(*) as cnt FROM EStopCheckPendingSyncs WHERE SubsystemId = ?')
          .get(subsystemId) as { cnt: number }).cnt
        const guidedPendingNow = (db
          .prepare('SELECT COUNT(*) as cnt FROM GuidedTaskStatePendingSyncs WHERE SubsystemId = ?')
          .get(subsystemId) as { cnt: number }).cnt
        if (pendingNow + estopPendingNow + guidedPendingNow > 0) {
          throw new Error(PENDING_APPEARED)
        }
      }

      // Ensure Projects/Subsystems rows exist.
      const existingProject = db.prepare('SELECT id FROM Projects WHERE id = 1').get()
      if (!existingProject) {
        db.prepare('INSERT INTO Projects (id, Name) VALUES (1, ?)').run('Default Project')
      }
      const existingSubsystem = db.prepare('SELECT id FROM Subsystems WHERE id = ?').get(subsystemId)
      if (!existingSubsystem) {
        db.prepare('INSERT INTO Subsystems (id, ProjectId, Name) VALUES (?, 1, ?)').run(
          subsystemId,
          subsystemName || `Subsystem ${subsystemId}`,
        )
      }

      if (global) {
        // GLOBAL wipe (single-MCM tablet only — the route's multi-MCM fence
        // guarantees this). The entire local Ios table belongs to the active
        // subsystem, so it is all replaced.
        const beforeCount = (db.prepare('SELECT COUNT(*) as cnt FROM Ios').get() as { cnt: number }).cnt
        const deleted = db.prepare('DELETE FROM Ios').run().changes
        console.log(`${logPrefix} DELETE FROM Ios: had ${beforeCount}, deleted ${deleted}`)
        // Clean up rows belonging to a DIFFERENT subsystem left over after a
        // tablet subsystem switch. Config sections themselves are NOT deleted
        // here — runConfigSidePulls owns each section's success-gated
        // scoped delete+reinsert (F1, 2026-07-03 audit).
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
      } else {
        // SCOPED delete — only this subsystem's IOs. Other MCMs' IOs survive.
        const deleted = db.prepare('DELETE FROM Ios WHERE SubsystemId = ?').run(subsystemId).changes
        console.log(`${logPrefix} Cleared ${deleted} existing IOs for subsystem ${subsystemId}`)
      }

      let upserted = 0
      for (const cloudIo of cloudIos) {
        if (!cloudIo.name || cloudIo.id <= 0) {
          console.warn(`${logPrefix} Skipping invalid IO: id=${cloudIo.id}, name=${cloudIo.name}`)
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
          upserted++
        } catch (err) {
          console.error(`${logPrefix} Failed to upsert IO ${cloudIo.id}:`, err)
        }
      }

      // Backfill NetworkDeviceName from tag names where missing.
      const updateDevice = db.prepare('UPDATE Ios SET NetworkDeviceName = ? WHERE id = ?')
      const need = (
        global
          ? db.prepare('SELECT id, Name FROM Ios WHERE NetworkDeviceName IS NULL').all()
          : db.prepare('SELECT id, Name FROM Ios WHERE SubsystemId = ? AND NetworkDeviceName IS NULL').all(subsystemId)
      ) as { id: number; Name: string }[]
      for (const io of need) {
        const dev = deps.extractDeviceName(io.Name)
        if (dev) updateDevice.run(dev, io.id)
      }

      return upserted
    })()
  } catch (txErr) {
    if (txErr instanceof Error && txErr.message === PENDING_APPEARED) {
      return { ok: false, kind: 'pending-appeared' }
    }
    throw txErr
  }
  console.log(`${logPrefix} Successfully upserted ${iosCount} IOs to local database`)

  // ── 4. TestHistories sync ───────────────────────────────────────────────────
  // Best-effort, its own transaction (a history failure must not roll back the
  // IO pull). The cloud payload's histories are already this subsystem's (both
  // routes fetch /api/sync/subsystem/<id>). The DELETE scope mirrors the IO
  // delete: global wipes the whole table (single-MCM); scoped clears only THIS
  // subsystem's IOs' histories so other MCMs' audit trails are never touched.
  let historiesPulled = 0
  if (Array.isArray(cloudHistories) && cloudHistories.length > 0) {
    try {
      db.transaction(() => {
        if (global) {
          db.prepare('DELETE FROM TestHistories').run()
        } else {
          db.prepare('DELETE FROM TestHistories WHERE IoId IN (SELECT id FROM Ios WHERE SubsystemId = ?)').run(subsystemId)
        }
        const insertHistory = db.prepare(
          `INSERT OR IGNORE INTO TestHistories (IoId, Result, TestedBy, Comments, FailureMode, State, Timestamp, Source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const h of cloudHistories) {
          if (!h.ioId || !h.timestamp) continue
          try {
            insertHistory.run(
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
            // Skip individual history records that fail.
          }
        }
      })()
      console.log(`${logPrefix} Pulled ${historiesPulled} test history records from cloud`)
    } catch (e) {
      console.error(`${logPrefix} Test history pull failed:`, e)
    }
  }

  // ── 5. classifyDescription tagType backfill ─────────────────────────────────
  try {
    const untyped = (
      global
        ? db.prepare('SELECT id, Description FROM Ios WHERE TagType IS NULL AND Description IS NOT NULL').all()
        : db.prepare('SELECT id, Description FROM Ios WHERE SubsystemId = ? AND TagType IS NULL AND Description IS NOT NULL').all(subsystemId)
    ) as { id: number; Description: string | null }[]
    let assigned = 0
    const updateTagType = db.prepare('UPDATE Ios SET TagType = ? WHERE id = ?')
    for (const io of untyped) {
      const tagType = classifyDescription(io.Description)
      if (tagType) {
        updateTagType.run(tagType, io.id)
        assigned++
      }
    }
    if (assigned > 0) {
      console.log(`${logPrefix} Auto-assigned tagType to ${assigned} IOs based on descriptions`)
    }
  } catch (error) {
    console.error(`${logPrefix} Error assigning tag types:`, error)
  }

  // ── 7. Config side-pulls + L2/FV ────────────────────────────────────────────
  // Each config section is a scoped, success-gated delete+reinsert (a failed or
  // empty fetch keeps the existing local rows). L2/FV is a separate self-call
  // that does its own scoped delete+insert and its own FV risk guard.
  const side = await doSidePulls(subsystemId, remoteUrl, apiPassword, { db })
  const l2 = await deps.pullL2(subsystemId, remoteUrl, apiPassword, force)

  return {
    ok: true,
    kind: 'ok',
    iosCount,
    historiesPulled,
    networkPulled: side.networkPulled,
    estopPulled: side.estopPulled,
    safetyPulled: side.safetyPulled,
    punchlistsPulled: side.punchlistsPulled,
    l2Pulled: l2.l2Pulled,
    l2CellsPulled: l2.l2CellsPulled,
    l2Error: l2.l2Error,
    pullWarning,
    atRisk,
    atRiskComments,
    divergent,
    atRiskClears,
  }
}
