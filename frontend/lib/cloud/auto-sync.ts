/**
 * Automatic Bidirectional Sync Service
 *
 * Runs in the background on the server:
 * - Push: Drains PendingSync queue to cloud every 10s (pushIntervalMs default)
 * - Pull: On SSE (re)connect only — no polling. SSE is the primary real-time channel;
 *         a full pull on reconnect catches any events missed during disconnect.
 *
 * Preserves data ownership:
 * - Cloud owns IO definitions (name, description, order)
 * - Site owns test results (result, timestamp, comments, testedBy)
 */

import { db } from '@/lib/db-sqlite'
import type { PendingSync } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { startCloudSse, stopCloudSse, getCloudSseClient } from '@/lib/cloud/cloud-sse-client'
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { mapPendingSyncToIoUpdate } from '@/lib/cloud/pending-sync-utils'
import { reconcileConfiguredSubsystems } from '@/lib/cloud/result-reconciler'
import { sendHeartbeat } from '@/lib/heartbeat/heartbeat-service'
import { auditLog } from '@/lib/logging/recovery-log'
import { mcmTag } from '@/lib/logging/mcm-tag'
import { isNetworkLevelFailure } from '@/lib/cloud/sync-failure-classification'
import { drainSimpleQueue, type SimpleQueueRow } from '@/lib/cloud/drain-simple-queue'
import { runJournalUpload } from '@/lib/cloud/journal-uploader'
import {
  type TelemetryState,
  pushNetworkStatus,
  pushEstopStatus,
  pushNetworkDiagnostics,
} from '@/lib/cloud/auto-sync-telemetry'
import {
  type PullState,
  createPullState,
  pullFromCloud,
  pullAllConfiguredMcms,
  pullSubsystemOnHint,
  pullVfdAddressedForConfigured,
  sweepConfiguredMcmsDelta,
} from '@/lib/cloud/auto-sync-pull'

export interface AutoSyncConfig {
  pushIntervalMs: number    // default 10000 (10s) — was 30s; tightened so
                            // cloud→laptop commands (ping/update) round-trip
                            // in seconds rather than minutes.
  enabled: boolean          // default true
}

const DEFAULT_AUTO_SYNC_CONFIG: AutoSyncConfig = {
  pushIntervalMs: 10000,
  enabled: true,
}

// Periodic cloud→field delta sweep cadence. The SSE `subsystem_changed` hint is
// the primary real-time channel; this timer is the safety net so a LOST hint
// (cloud crash between commit and broadcast, a future 2nd replica, a dropped SSE
// frame) can never leave a tablet stale for more than a few minutes. Conservative
// default — a no-op delta poll is cheap, but this must not hammer the endpoint.
// Overridable via CLOUD_DELTA_SWEEP_SECONDS (mirrors SYNC_SAFETY_PULL_MINUTES).
const DEFAULT_DELTA_SWEEP_SECONDS = 120
function resolveDeltaSweepMs(): number {
  const s = parseInt(process.env.CLOUD_DELTA_SWEEP_SECONDS || '', 10)
  const seconds = Number.isFinite(s) && s > 0 ? s : DEFAULT_DELTA_SWEEP_SECONDS
  return seconds * 1000
}

export interface AutoSyncStatus {
  running: boolean
  config: AutoSyncConfig
  lastPushAt: string | null
  lastPullAt: string | null
  lastPushResult: string | null
  lastPullResult: string | null
  pendingCount: number | null
}

class AutoSyncService {
  private pushTimer: NodeJS.Timeout | null = null
  private networkStatusTimer: NodeJS.Timeout | null = null
  private estopStatusTimer: NodeJS.Timeout | null = null
  private networkDiagnosticsTimer: NodeJS.Timeout | null = null
  private journalUploadTimer: NodeJS.Timeout | null = null
  private deltaSweepTimer: NodeJS.Timeout | null = null
  private sseUnsubscribe: (() => void) | null = null
  private sseSubsystemChangedUnsub: (() => void) | null = null
  private config: AutoSyncConfig
  private isPushing = false
  private mcmSafetyTimer: NodeJS.Timeout | null = null
  private _lastPushAt: Date | null = null
  private _lastPushResult: string | null = null
  private _running = false
  // Per-instance re-entrancy guards for the extracted telemetry pushers.
  private telemetry: TelemetryState = {
    isPushingNetworkStatus: false,
    isPushingEstopStatus: false,
    isPushingNetworkDiagnostics: false,
  }
  // Per-instance run state for the extracted pull / catch-up paths (guards,
  // throttle timestamps, last-pull status, IO version hash). Mutated by
  // reference inside auto-sync-pull.ts.
  private pull: PullState = createPullState()

  constructor(config: Partial<AutoSyncConfig> = {}) {
    this.config = { ...DEFAULT_AUTO_SYNC_CONFIG, ...config }
  }

  get running(): boolean {
    return this._running
  }

  start(): void {
    if (!this.config.enabled) return
    if (this._running) return

    console.log('[AutoSync] Starting background sync...')
    console.log(`[AutoSync] Push interval: ${this.config.pushIntervalMs}ms, Pull: on SSE (re)connect only`)

    this._running = true

    // Start push loop (drain pending syncs).
    // Heartbeat piggybacks on this same tick — fire-and-forget so it
    // can never block or fail the IO push.
    this.pushTimer = setInterval(() => {
      this.pushToCloud()
      void sendHeartbeat()
    }, this.config.pushIntervalMs)

    // Do an initial push attempt after 5 seconds (let server fully start).
    // Same logic for heartbeat — let a freshly-started tool report in
    // right away rather than waiting a full 10 s cycle.
    setTimeout(() => {
      this.pushToCloud()
      void sendHeartbeat()
    }, 5000)

    // Push network status to cloud every 5 seconds (lightweight, tag booleans only)
    this.networkStatusTimer = setInterval(() => pushNetworkStatus(this.telemetry), 5000)

    // Push estop status to cloud every 5 seconds
    this.estopStatusTimer = setInterval(() => pushEstopStatus(this.telemetry), 5000)

    // Push UDT_NETWORK_NODE diagnostics batch to cloud every 60 seconds.
    // Heavier payload than network-status (108 bytes per device, dozens of
    // counters each), so spaced out far more — diagnostics counters change
    // slowly and the cloud modal only polls at 30 s anyway.
    this.networkDiagnosticsTimer = setInterval(() => pushNetworkDiagnostics(this.telemetry), 60_000)
    // First push 15 s after startup so the cloud has data soon after a tool
    // launch, rather than waiting a full minute.
    setTimeout(() => pushNetworkDiagnostics(this.telemetry), 15_000)

    // Ship recovery-journal (audit-*.jsonl) lines to the cloud so forensics
    // survive tablet loss. Slow cadence — the journal is low-frequency and the
    // uploader is chunked/resumable. First run ~2 min after start (let config
    // + network settle), then every 6 hours. Best-effort: never throws.
    this.journalUploadTimer = setInterval(() => { void runJournalUpload() }, 6 * 60 * 60_000)
    setTimeout(() => { void runJournalUpload() }, 2 * 60_000)

    // Periodic safety-net catch-up pull for ALL configured MCMs. The SSE stream
    // delivers cloud changes in real time, but if events are missed during a
    // disconnect this reconciles every MCM. Conservative interval; the pull
    // self-guards (skips MCMs with unsynced local work, throttled).
    const safetyMin = parseInt(process.env.SYNC_SAFETY_PULL_MINUTES || '', 10)
    const safetyMinutes = Number.isFinite(safetyMin) && safetyMin > 0 ? safetyMin : 15
    this.mcmSafetyTimer = setInterval(
      () => {
        // Re-enqueue orphaned local results FIRST so the pull's guard sees them
        // as pending work and protects them, and the next push delivers them.
        void this.reconcileOrphans('periodic safety')
        void pullAllConfiguredMcms(this.pull, 'periodic safety')
      },
      safetyMinutes * 60_000
    )

    // Periodic cloud→field DELTA SWEEP (default ~120s). Tighter cadence than the
    // 15-min full-pull safety net above, but far cheaper: it runs ONLY the
    // granular delta path (`pullSubsystemOnHint` → `fetchAndApplyDelta`) per
    // managed subsystem, which is a no-op poll when nothing changed since the
    // cursor. Its job is to bound cloud→field staleness when an SSE hint is
    // lost, so a missed change can't sit unfetched until the next unrelated
    // hint/reconnect. Self-guards against overlap and recent manual pulls.
    const deltaSweepMs = resolveDeltaSweepMs()
    this.deltaSweepTimer = setInterval(
      () => { void sweepConfiguredMcmsDelta(this.pull, 'periodic delta sweep') },
      deltaSweepMs
    )
    console.log(`[AutoSync] Delta sweep every ${Math.round(deltaSweepMs / 1000)}s (lost-hint safety net)`)

    // Start SSE client for real-time cloud updates (after 10s to let config load)
    setTimeout(async () => {
      try {
        const config = await configService.getConfig()
        if (config.remoteUrl && config.subsystemId) {
          const sseClient = startCloudSse({
            remoteUrl: config.remoteUrl,
            apiPassword: config.apiPassword || '',
            subsystemId: config.subsystemId,
          })
          // When SSE (re)connects, push pending items + pull to catch missed events
          if (this.sseUnsubscribe) this.sseUnsubscribe()
          this.sseUnsubscribe = sseClient.onConnect(() => {
            console.log('[AutoSync] Cloud SSE connected — pushing pending + pulling to catch up')
            this.pushToCloud()
            // Net just came back: sweep for orphaned local results the cloud is
            // missing (dropped from the queue without ever landing) and re-enqueue
            // them so this reconnect delivers them too.
            void this.reconcileOrphans('SSE reconnect')
            // Catch up EVERY configured MCM (central-server), not just the one
            // in config.subsystemId — events missed during the disconnect could
            // belong to any MCM.
            void pullAllConfiguredMcms(this.pull, 'SSE reconnect')
            // Refresh the cloud-authoritative belt-tracking ADDRESSED flag
            // (mechanic-set, cloud-only) so the field VFD page reflects it.
            void pullVfdAddressedForConfigured(this.pull, 'SSE reconnect')
          })
          // React to cloud-side CRUD hints (IO add/delete, network/estop/safety
          // import) the moment they happen — the io_updated result path doesn't
          // carry them, so without this they'd only land on the next reconnect
          // or 15-min safety sweep. The client debounces bursts per subsystem.
          if (this.sseSubsystemChangedUnsub) this.sseSubsystemChangedUnsub()
          this.sseSubsystemChangedUnsub = sseClient.onSubsystemChanged((sid) => {
            void pullSubsystemOnHint(this.pull, sid)
          })
        }
      } catch (err) {
        console.warn('[AutoSync] Failed to start SSE client:', err)
      }

      // Subscribe to config changes so SSE client stays in sync
      configService.onChange((event) => {
        const cloudFieldsChanged = event.changedFields.some(f =>
          f === 'remoteUrl' || f === 'apiPassword' || f === 'subsystemId'
        )
        if (cloudFieldsChanged) {
          const c = event.currentConfig
          if (c.remoteUrl && c.subsystemId) {
            const sseClient = getCloudSseClient()
            if (sseClient) {
              sseClient.updateConfig({
                remoteUrl: c.remoteUrl,
                apiPassword: c.apiPassword || '',
                subsystemId: c.subsystemId,
              })
            } else {
              startCloudSse({
                remoteUrl: c.remoteUrl,
                apiPassword: c.apiPassword || '',
                subsystemId: c.subsystemId,
              })
            }
          }
        }
      })
    }, 10000)
  }

  stop(): void {
    stopCloudSse()
    if (this.pushTimer) clearInterval(this.pushTimer)
    if (this.networkStatusTimer) clearInterval(this.networkStatusTimer)
    if (this.estopStatusTimer) clearInterval(this.estopStatusTimer)
    if (this.networkDiagnosticsTimer) clearInterval(this.networkDiagnosticsTimer)
    if (this.journalUploadTimer) clearInterval(this.journalUploadTimer)
    if (this.mcmSafetyTimer) clearInterval(this.mcmSafetyTimer)
    if (this.deltaSweepTimer) clearInterval(this.deltaSweepTimer)
    this.pushTimer = null
    this.networkStatusTimer = null
    this.estopStatusTimer = null
    this.networkDiagnosticsTimer = null
    this.journalUploadTimer = null
    this.mcmSafetyTimer = null
    this.deltaSweepTimer = null
    this._running = false
    console.log('[AutoSync] Stopped')
  }

  getStatus(): AutoSyncStatus {
    let pendingCount: number | null = null
    try {
      // ACTIVE rows only — parked (DeadLettered=1) rows are reported separately
      // as "attention", not as pending work waiting to sync.
      pendingCount = (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs WHERE DeadLettered = 0').get() as any).count
    } catch { /* db might not be ready */ }

    return {
      running: this._running,
      config: this.config,
      lastPushAt: this._lastPushAt?.toISOString() ?? null,
      lastPullAt: this.pull.lastPullAt?.toISOString() ?? null,
      lastPushResult: this._lastPushResult,
      lastPullResult: this.pull.lastPullResult,
      pendingCount,
    }
  }

  /**
   * Best-effort SubsystemId for an IO row, for enriching recovery-audit
   * payloads (sync.push.drop / .park) so a dropped/parked result can be
   * attributed to its MCM on a central server. Returns null when unknown.
   */
  private ioSubsystemId(ioId: number): number | null {
    try {
      const row = db.prepare('SELECT SubsystemId FROM Ios WHERE id = ?').get(ioId) as { SubsystemId: number | null } | undefined
      return row?.SubsystemId ?? null
    } catch {
      return null
    }
  }

  /**
   * Best-effort subsystem label for an L2 cell, derived via the cloud device id
   * (L2Devices.CloudId → L2Devices.Subsystem). L2 tables carry no numeric
   * SubsystemId, only the TEXT `Subsystem` label — returned as-is for the audit
   * payload, or null when it can't be resolved (recorded with a note by callers).
   */
  private l2SubsystemLabel(cloudDeviceId: number | null | undefined): string | null {
    if (cloudDeviceId == null) return null
    try {
      const row = db.prepare('SELECT Subsystem FROM L2Devices WHERE CloudId = ?').get(cloudDeviceId) as { Subsystem: string | null } | undefined
      return row?.Subsystem ?? null
    } catch {
      return null
    }
  }

  private async pushToCloud(): Promise<void> {
    if (this.isPushing) return
    this.isPushing = true

    try {
      // Drop IO pending-sync rows that have failed too many times. Mirrors the
      // L2 PENDING_RETRY_CAP below — the previous behaviour was to retry
      // forever, which on a non-recoverable cloud rejection (e.g. cloud's
      // updatedCount=0 because the IO doesn't exist on the cloud side, or
      // cloud has already moved past us) would leave a row in PendingSyncs
      // permanently. The pull at line ~495 skips when ANY pending rows exist,
      // so one stuck IO would block all IO catch-up pulls forever.
      //
      // IMPORTANT (2026-06-04 TPA8/MCM08 incident): a strike is ONLY counted
      // when the cloud actually processed the payload and said no (see
      // isNetworkLevelFailure). Offline / timeout / 5xx / 401 failures keep
      // the row alive indefinitely — a site with no internet must NEVER
      // lose its queue, because the manual-pull guard relies on these rows
      // to refuse a destructive pull. 10 strikes = 10 genuine cloud
      // rejections; the user's next pass/fail/clear creates a fresh row at
      // the current version.
      const IO_PENDING_RETRY_CAP = 10

      // ── B7 reconcile: version-conflicted rows vs cloud truth ─────────
      // `updatedCount=0` rows are usually AT-LEAST-ONCE GHOSTS: the push
      // landed cloud-side but the ack was lost (cloud-flap timeout), so
      // every retry re-sends a stale base version, burns strikes toward the
      // park cap, and eventually wedges as a parked row — while the value
      // is ALREADY safely on the cloud (reproduced at scale by the battle
      // central-cdw5 soaks, 2026-06-07: 85 parked rows, all this class).
      // Resolve them against cloud truth instead of retrying blind:
      //   cloud value == row value          → already applied → delete row
      //   newer pending row for the same IO → superseded      → delete row
      //   else → REBASE the base version to cloud's, clear strikes and
      //          un-park (local is the result authority; next push wins).
      try {
        await this.reconcileVersionConflicts()
      } catch (e) {
        console.warn('[AutoSync] B7 reconcile failed (non-fatal):', e)
      }

      try {
        // Before deleting, log each row in detail. The 2026-05-21 incident
        // showed that the previous "Dropped N rows" summary was useless for
        // recovery — once the rows were gone, we couldn't see which IOs lost
        // a test or who tested them. Now every drop emits a structured line
        // that grep can find later.
        // Only rows about to be NEWLY parked (DeadLettered = 0) — without this
        // filter the audit log would re-emit every already-parked row each
        // cycle.
        // Version-conflict rows get DOUBLE the cap before parking: they are
        // the B7 reconcile's job (usually at-least-once ghosts that resolve
        // against cloud truth within a couple of reconcile windows), and a
        // premature park reads as a suspect drop to the battle observer.
        const toDrop = db.prepare(
          `SELECT id, IoId, InspectorName, TestResult, Comments, State, Version, Timestamp, RetryCount, CreatedAt
             FROM PendingSyncs
            WHERE DeadLettered = 0
              AND (
                    (LastError NOT LIKE '%updatedCount=0%' AND RetryCount >= ?)
                 OR (LastError LIKE '%updatedCount=0%' AND RetryCount >= ?)
                  )`
        ).all(IO_PENDING_RETRY_CAP, IO_PENDING_RETRY_CAP * 2) as PendingSync[]

        if (toDrop.length > 0) {
          console.warn(
            `[AutoSync] PARKING ${toDrop.length} IO pending sync row(s) that exceeded ` +
            `retry cap (${IO_PENDING_RETRY_CAP}) — kept for attention, NOT deleted. ` +
            `Cloud likely already has the values or the IO does not exist on cloud — ` +
            `Pull IOs to verify; re-pass/fail/clear in the grid if any result is missing.`
          )
          for (const p of toDrop) {
            const droppedSubsystemId = this.ioSubsystemId(p.IoId)
            console.warn(
              `${mcmTag(droppedSubsystemId)}[AutoSync] DROP-DETAIL pendingId=${p.id} ioId=${p.IoId} ` +
              `result=${JSON.stringify(p.TestResult)} ` +
              `version=${p.Version} tester=${JSON.stringify(p.InspectorName)} ` +
              `state=${JSON.stringify(p.State)} ` +
              `comments=${JSON.stringify(p.Comments)} ` +
              `ts=${p.Timestamp} retries=${p.RetryCount} createdAt=${p.CreatedAt}`
            )
            // Recovery-critical: the same payload in the durable 2-week audit
            // log, so a wrongly-dropped result can be reconstructed/re-pushed.
            auditLog({
              type: 'sync.push.drop',
              ioId: p.IoId,
              subsystemId: droppedSubsystemId,
              version: p.Version,
              result: p.TestResult,
              user: p.InspectorName,
              reason: `retry-cap (${IO_PENDING_RETRY_CAP} retries exceeded)`,
              detail: {
                pendingId: p.id,
                comments: p.Comments,
                state: p.State,
                timestamp: p.Timestamp,
                retries: p.RetryCount,
                createdAt: p.CreatedAt,
              },
            })
          }

          // Scream in the UI, not just the logs. The 2026-06-04 TPA8/MCM08
          // incident went unnoticed for a week because drops only ever hit
          // app.log — the grid kept showing the (local) results, so the crew
          // had no idea their work wasn't reaching the cloud. An ErrorEvent
          // broadcast becomes a red toast + error-log entry on every
          // connected browser.
          try {
            const ioSummaries = toDrop.slice(0, 3).map(p => {
              const io = db.prepare('SELECT Name FROM Ios WHERE id = ?').get(p.IoId) as { Name: string } | undefined
              return `${io?.Name ?? `IO ${p.IoId}`}=${p.TestResult ?? '?'}`
            })
            const more = toDrop.length > 3 ? ` (+${toDrop.length - 3} more)` : ''
            const broadcastUrl = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast'
            await fetch(broadcastUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'ErrorEvent',
                severity: 'error',
                source: 'system',
                message:
                  `SYNC DROPPED ${toDrop.length} result(s) after ${IO_PENDING_RETRY_CAP} cloud rejections: ` +
                  `${ioSummaries.join(', ')}${more}. The grid still shows them locally, but the cloud refused ` +
                  `them — re-pass/fail these IOs or tell support before pulling.`,
                timestamp: new Date().toISOString(),
              }),
            })
          } catch { /* WS server might not be running */ }
        }

        // B7: PARK rows that exhausted the retry cap — do NOT delete them.
        // A capped row is one the cloud kept rejecting with a verdict (e.g. a
        // version conflict the tool couldn't re-base); deleting it on the
        // assumption "cloud already has it" silently loses genuinely-unsynced
        // field work. Dead-lettering keeps the local result + reason and
        // surfaces it as "needs attention" instead.
        const dropped = db.prepare(
          `UPDATE PendingSyncs SET DeadLettered = 1, LastError = COALESCE(LastError, 'retry cap exhausted')
            WHERE DeadLettered = 0
              AND (
                    (LastError NOT LIKE '%updatedCount=0%' AND RetryCount >= ?)
                 OR (LastError LIKE '%updatedCount=0%' AND RetryCount >= ?)
                  )`
        ).run(IO_PENDING_RETRY_CAP, IO_PENDING_RETRY_CAP * 2)
        if (dropped.changes > 0) {
          console.warn(
            `[AutoSync] PARKED ${dropped.changes} row(s) at the retry cap (kept for attention, not deleted)`
          )
        }
      } catch (e) {
        console.warn('[AutoSync] Failed to apply IO retry cap:', e)
      }

      const pendingSyncs = db.prepare(
        'SELECT * FROM PendingSyncs WHERE DeadLettered = 0 ORDER BY CreatedAt ASC LIMIT 50'
      ).all() as PendingSync[]

      const config = await configService.getConfig()
      const remoteUrl = config.remoteUrl
      const apiPassword = config.apiPassword

      if (!remoteUrl) {
        this._lastPushResult = 'no remote URL configured'
        return
      }

      let syncedIoCount = 0
      let failedIoCount = 0
      if (pendingSyncs.length > 0) {
        console.log(`[AutoSync] Pushing ${pendingSyncs.length} pending results to cloud...`)

        const syncService = getCloudSyncService()
        const blockedIoIds = new Set<number>()
        // F19 (2026-07-03 sync audit): tolerate a few isolated network-level
        // failures before deferring the whole batch. A single blip used to
        // abandon all remaining rows to the next 10s cycle, serializing the
        // drain painfully on flaky links; a truly-down cloud still stops the
        // batch after this many timeouts.
        const NETWORK_FAILURE_BATCH_TOLERANCE = 3
        let networkFailures = 0

        for (const pending of pendingSyncs) {
          if (blockedIoIds.has(pending.IoId)) {
            continue
          }

          const r = await syncService.syncIoUpdate(mapPendingSyncToIoUpdate(pending))
          if (r.ok) {
            pendingSyncRepository.delete(pending.id)
            // A newer write for this IO just reached cloud — any earlier PARKED
            // (rejected/capped) row for the same IO is now stale; clear it so
            // the "needs attention" surface doesn't keep flagging a resolved IO.
            try { db.prepare('DELETE FROM PendingSyncs WHERE IoId = ? AND DeadLettered = 1').run(pending.IoId) } catch { /* best-effort */ }
            // Per-row trail so forensics can answer "did this specific IO
            // actually reach cloud?" without joining the summary line below
            // back to the queue snapshot.
            console.log(
              `${mcmTag(this.ioSubsystemId(pending.IoId))}[AutoSync] Pushed pendingId=${pending.id} ioId=${pending.IoId} ` +
              `result=${JSON.stringify(pending.TestResult)} version=${pending.Version} ` +
              `tester=${JSON.stringify(pending.InspectorName)}`,
            )
            syncedIoCount++
          } else if (r.permanent) {
            // Permanent reject (e.g. SPARE cannot be Passed): the cloud will
            // never accept this value. PARK it (don't delete) so the local
            // result + reason survive and the tester is told "cloud rejected
            // N results" instead of the result silently vanishing while the
            // queue count drops to 0 and the UI reads "synced" (B3/B5).
            pendingSyncRepository.deadLetter(pending.id, r.reason ?? 'cloud permanently rejected')
            // Durable 2-week audit trail for the rejected result (was console
            // only) — so "why did this IO never reach cloud" is answerable later.
            const parkedSubsystemId = this.ioSubsystemId(pending.IoId)
            auditLog({
              type: 'sync.push.park',
              ioId: pending.IoId,
              subsystemId: parkedSubsystemId,
              version: pending.Version,
              result: pending.TestResult,
              user: pending.InspectorName,
              reason: `cloud permanent reject: ${r.reason ?? 'unknown'}`,
              detail: { pendingId: pending.id, comments: pending.Comments, state: pending.State },
            })
            console.warn(
              `${mcmTag(parkedSubsystemId)}[AutoSync] PARKED-PERMANENT pendingId=${pending.id} ioId=${pending.IoId} ` +
              `reason=${JSON.stringify(r.reason ?? 'unknown')} ` +
              `result=${JSON.stringify(pending.TestResult)} version=${pending.Version}`,
            )
            failedIoCount++
            blockedIoIds.add(pending.IoId)
          } else if (r.network) {
            // Network-level failure (offline / timeout / 5xx / 401): the
            // cloud never ruled on this row. Do NOT burn a retry-cap strike
            // — that's what silently emptied the queue during the
            // 2026-06-04 TPA8/MCM08 outage and let the pull wipe 818
            // results. Stop the batch: every later row would fail the same
            // way, and each attempt costs up to a 15 s timeout.
            pendingSyncRepository.recordTransientFailure(pending.id, r.reason ?? 'network failure')
            failedIoCount++
            networkFailures++
            if (networkFailures >= NETWORK_FAILURE_BATCH_TOLERANCE) {
              console.log(`[AutoSync] ${networkFailures} network-level push failures (${r.reason ?? 'unknown'}) — deferring remaining queued row(s) to next cycle, no retry strikes burned`)
              break
            }
            console.log(`[AutoSync] Network-level push failure ${networkFailures}/${NETWORK_FAILURE_BATCH_TOLERANCE} (${r.reason ?? 'unknown'}) — continuing batch, no retry strikes burned`)
          } else {
            blockedIoIds.add(pending.IoId)
            pendingSyncRepository.recordFailure(pending.id, r.reason ?? 'Background sync failed')
            failedIoCount++
          }
        }

        if (syncedIoCount > 0) {
          console.log(`[AutoSync] Pushed ${syncedIoCount} results to cloud`)
        }
      }

      this._lastPushAt = new Date()
      this._lastPushResult =
        syncedIoCount > 0 || failedIoCount > 0
          ? `pushed ${syncedIoCount} results${failedIoCount > 0 ? `, ${failedIoCount} failed` : ''}`
          : 'nothing to push'

      // Also push pending change requests to cloud
      try {
        const pendingRequests = db.prepare(
          'SELECT * FROM ChangeRequests WHERE Status = ? AND CloudId IS NULL LIMIT 100'
        ).all('pending') as any[]

        if (pendingRequests.length > 0 && remoteUrl) {
          const resp = await fetch(`${remoteUrl}/api/sync/change-requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
            body: JSON.stringify({ requests: pendingRequests.map(r => ({
              localId: r.id,
              ioId: r.IoId,
              requestType: r.RequestType,
              currentValue: r.CurrentValue,
              requestedValue: r.RequestedValue,
              structuredChanges: r.StructuredChanges ? JSON.parse(r.StructuredChanges) : null,
              reason: r.Reason,
              requestedBy: r.RequestedBy,
              createdAt: r.CreatedAt,
            })) }),
            signal: AbortSignal.timeout(10000),
          })
          if (resp.ok) {
            const data = await resp.json()
            const acknowledgedRequests = Array.isArray(data.requests) ? data.requests : []
            const acknowledgedIds = acknowledgedRequests
              .map((cr: any) => Number(cr.localId))
              .filter((id: number) => Number.isInteger(id) && id > 0)

            if (acknowledgedIds.length > 0) {
              const crPlaceholders = acknowledgedIds.map(() => '?').join(',')
              db.prepare(`UPDATE ChangeRequests SET Status = 'synced' WHERE id IN (${crPlaceholders})`).run(...acknowledgedIds)

              const updateCrStmt = db.prepare('UPDATE ChangeRequests SET CloudId = ? WHERE id = ?')
              for (const cr of acknowledgedRequests) {
                if (cr.localId && cr.cloudId) {
                  try { updateCrStmt.run(cr.cloudId, cr.localId) } catch (e) { console.warn('[AutoSync] Failed to update CR cloudId:', e) }
                }
              }
            }
            console.log(`[AutoSync] Cloud acknowledged ${acknowledgedIds.length}/${pendingRequests.length} change requests`)
          }
        }
      } catch (err) {
        console.warn('[AutoSync] Change request push error:', err instanceof Error ? err.message : err)
      }

      // Push pending L2 cell value changes to cloud
      // Strategy: re-read latest local VALUE (handles rapid edits — always push final
      // value), but use the OLDEST stored pending sync version as the base version.
      //
      // Why not local.Version - 1? When multiple people edit the same cell while the
      // first push is in-flight (slow/bad network), local version jumps ahead by N
      // but cloud hasn't moved. Using local.Version - 1 sends a base version the
      // cloud has never seen → permanent version conflict.
      //
      // The oldest pending sync's Version was captured at the moment of the first
      // failed edit — it's what the cloud actually had at that point.
      try {
        // Step 0 — drop pending rows that have failed too many times. The
        // strict-version-equality protocol on cloud rejects the push when
        // cloud's version has moved past local's stored base, and retrying
        // forever just inflates RetryCount without ever reconciling. Most
        // common single-user trigger: a network blip mid-push where cloud
        // committed but the response was lost — cloud is already at the
        // value we're trying to send, but local doesn't know. Capping the
        // retries means the stuck row clears itself; if cloud actually
        // doesn't have the value, the user's next write creates a fresh
        // pending row at the current version. With 10 s sync intervals, a
        // cap of 10 = ~100 s of trying before we give up on the row.
        const PENDING_RETRY_CAP = 10
        // Capture the rows BEFORE deleting so each discarded L2 cell value lands
        // in the recovery audit log (parallel to the IO drop above).
        const l2ToDrop = db.prepare(
          `SELECT id, CloudDeviceId, CloudColumnId, Value, Version, UpdatedBy, RetryCount, CreatedAt
             FROM L2PendingSyncs WHERE DeadLettered = 0 AND RetryCount >= ?`
        ).all(PENDING_RETRY_CAP) as any[]
        for (const p of l2ToDrop) {
          const l2Subsystem = this.l2SubsystemLabel(p.CloudDeviceId)
          auditLog({
            // PARKED (DeadLettered=1), not deleted — the row and its value survive
            // and are surfaced for attention. Dedicated l2.* type so FV events are
            // greppable in the recovery log (was piggybacked on sync.push.drop).
            type: 'l2.push.park',
            // L2 tables carry no numeric SubsystemId — best-effort TEXT label
            // via L2Devices.Subsystem, or null when it can't be resolved.
            subsystemId: l2Subsystem,
            version: p.Version,
            user: p.UpdatedBy,
            reason: `L2 retry-cap (${PENDING_RETRY_CAP} retries exceeded) — parked for attention`,
            detail: {
              kind: 'l2cell',
              pendingId: p.id,
              cloudDeviceId: p.CloudDeviceId,
              cloudColumnId: p.CloudColumnId,
              subsystemLabel: l2Subsystem,
              subsystemNote: l2Subsystem == null ? 'L2 SubsystemId unavailable (no numeric col; device row absent)' : undefined,
              value: p.Value,
              retries: p.RetryCount,
              createdAt: p.CreatedAt,
            },
          })
        }
        // B7 parity (L2): PARK rows that exhausted the retry cap — do NOT delete
        // them. A capped row is one the cloud kept rejecting; deleting it on the
        // assumption "cloud already has it" silently loses genuinely-unsynced
        // wizard cell values. Dead-lettering keeps the local value + reason and
        // surfaces it as "needs attention" instead, and excludes it from the
        // active push loop and the pull gate (so it can't livelock the pull).
        const dropped = db.prepare(
          `UPDATE L2PendingSyncs SET DeadLettered = 1, LastError = COALESCE(LastError, 'L2 retry cap exhausted')
            WHERE DeadLettered = 0 AND RetryCount >= ?`
        ).run(PENDING_RETRY_CAP)
        if (dropped.changes > 0) {
          console.warn(
            `[AutoSync] PARKED ${dropped.changes} L2 pending sync row(s) that exceeded ` +
            `retry cap (${PENDING_RETRY_CAP}) — kept for attention, not deleted. ` +
            `Cloud likely already has the values — ` +
            `Pull L2 to verify; click Confirm again in the wizard if any cell is missing.`
          )
          // Visible alert in every connected browser (see IO drop block above).
          try {
            const broadcastUrl = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast'
            await fetch(broadcastUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'ErrorEvent',
                severity: 'error',
                source: 'system',
                message:
                  `SYNC DROPPED ${dropped.changes} FV/L2 cell value(s) after ${PENDING_RETRY_CAP} cloud ` +
                  `rejections. Re-confirm the affected wizard checks or tell support before pulling.`,
                timestamp: new Date().toISOString(),
              }),
            })
          } catch { /* WS server might not be running */ }
        }

        const l2Pending = db.prepare(
          'SELECT * FROM L2PendingSyncs WHERE DeadLettered = 0 ORDER BY CreatedAt ASC LIMIT 50'
        ).all() as any[]

        if (l2Pending.length > 0) {
          // Deduplicate: if multiple pending syncs exist for the same cell, keep the
          // one with the LOWEST Version (closest to what cloud actually has) and the
          // LATEST value. Delete the rest.
          const cellMap = new Map<string, any>()
          const stalePendingIds: number[] = []
          for (const p of l2Pending) {
            const key = `${p.CloudDeviceId}-${p.CloudColumnId}`
            const existing = cellMap.get(key)
            if (!existing) {
              cellMap.set(key, p)
            } else {
              // Keep the row with the LOWEST version (= closest to cloud's real version)
              if (p.Version < existing.Version) {
                stalePendingIds.push(existing.id)
                cellMap.set(key, p)
              } else {
                stalePendingIds.push(p.id)
              }
            }
          }
          if (stalePendingIds.length > 0) {
            const placeholders = stalePendingIds.map(() => '?').join(',')
            db.prepare(`DELETE FROM L2PendingSyncs WHERE id IN (${placeholders})`).run(...stalePendingIds)
          }

          const dedupedPending = Array.from(cellMap.values())

          // For each pending sync, look up the current local cell VALUE (latest),
          // but use the stored Version from PendingSync (the cloud's expected version).
          const getLocalCell = db.prepare(`
            SELECT cv.Value, cv.Version, cv.UpdatedBy
            FROM L2CellValues cv
            JOIN L2Devices d ON d.id = cv.DeviceId
            JOIN L2Columns c ON c.id = cv.ColumnId
            WHERE d.CloudId = ? AND c.CloudId = ?
          `)

          const l2Updates = dedupedPending.map((p: any) => {
            const local = getLocalCell.get(p.CloudDeviceId, p.CloudColumnId) as { Value: string | null; Version: number; UpdatedBy: string | null } | undefined
            return {
              pendingId: p.id,
              deviceId: p.CloudDeviceId,
              columnId: p.CloudColumnId,
              value: local ? local.Value : p.Value,                // latest local value
              version: p.Version,                                  // stored base version (what cloud has)
              updatedBy: local?.UpdatedBy || p.UpdatedBy,
            }
          })

          const l2Resp = await fetch(`${remoteUrl}/api/sync/l2/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
            body: JSON.stringify({ updates: l2Updates.map(({ pendingId, ...rest }) => rest) }),
            signal: AbortSignal.timeout(15000),
          })

          if (l2Resp.ok) {
            const l2Data = await l2Resp.json()

            // Build set of (deviceId, columnId) keys that succeeded
            const updatedKeys = new Set(
              (l2Data.updates || []).map((u: any) => `${u.deviceId}-${u.columnId}`)
            )

            // Delete ALL pendingSyncs for cells that succeeded — not just the one
            // we pushed, but any that accumulated while this push was in flight.
            const deleteAllForCell = db.prepare('DELETE FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ? AND DeadLettered = 0')
            let successCount = 0
            for (const u of l2Updates) {
              if (updatedKeys.has(`${u.deviceId}-${u.columnId}`)) {
                deleteAllForCell.run(u.deviceId, u.columnId)
                successCount++
              }
            }

            // For conflicts: rebase pending row's Version to the cloud's current
            // version so the next retry sends the right base. Cloud's protocol
            // already treats "same value, any version" as an idempotent no-op
            // (lost-ACK case), so reaching the conflict branch means values
            // genuinely differ — local is the authority per CLAUDE.md, so we
            // want the local value to win on the next attempt.
            const conflictsByKey = new Map<string, number>()
            for (const c of (l2Data.conflicts || []) as Array<{ deviceId: number; columnId: number; cloudVersion: number }>) {
              if (typeof c?.cloudVersion === 'number') {
                conflictsByKey.set(`${c.deviceId}-${c.columnId}`, c.cloudVersion)
              }
            }

            // Increment RetryCount on rebase so the 10-strike cap still fires for
            // rows that can't resolve. Resetting to 0 (earlier code) caused a
            // livelock that left rows in L2PendingSyncs forever and permanently
            // blocked /api/cloud/pull (totalPendingCount > 0 → 409). See v2.27
            // regression notes.
            const rebaseStmt = db.prepare(
              `UPDATE L2PendingSyncs SET Version = ?, RetryCount = RetryCount + 1, LastError = ? WHERE CloudDeviceId = ? AND CloudColumnId = ? AND DeadLettered = 0`
            )
            const incrementStmt = db.prepare(
              'UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?'
            )

            const conflictedUpdates = l2Updates.filter(u => !updatedKeys.has(`${u.deviceId}-${u.columnId}`))
            let rebasedCount = 0
            for (const u of conflictedUpdates) {
              const cloudVersion = conflictsByKey.get(`${u.deviceId}-${u.columnId}`)
              if (typeof cloudVersion === 'number') {
                try {
                  rebaseStmt.run(cloudVersion, 'rebased after version conflict', u.deviceId, u.columnId)
                  rebasedCount++
                } catch (e) {
                  console.warn('[AutoSync] Failed to rebase L2 pending:', e)
                }
              } else {
                // No conflict info from cloud — defensive fallback to the old behavior so
                // the retry cap still kicks in if the row is unrecoverable.
                try { incrementStmt.run('version conflict (no cloudVersion)', u.pendingId) } catch (e) { console.warn('[AutoSync] Failed to update L2 retry count:', e) }
              }
            }

            const updatedCount = l2Data.updatedCount ?? successCount
            const conflictCount = l2Data.conflictCount ?? conflictedUpdates.length
            if (conflictCount > 0) {
              console.log(`[AutoSync] Pushed ${updatedCount} L2 cell updates to cloud (${conflictCount} conflicts, ${rebasedCount} rebased to cloud version — next loop should succeed)`)
            } else if (updatedCount > 0) {
              console.log(`[AutoSync] Pushed ${updatedCount} L2 cell updates to cloud`)
            }
          } else if (isNetworkLevelFailure({ httpStatus: l2Resp.status })) {
            // 5xx / 401: cloud or proxy didn't rule on the rows — keep them
            // alive, no retry-cap strikes (TPA8/MCM08 2026-06-04 lesson).
            for (const p of dedupedPending) {
              try { db.prepare('UPDATE L2PendingSyncs SET LastError = ? WHERE id = ?').run(`HTTP ${l2Resp.status} (network-level, no strike)`, p.id) } catch (e) { console.warn('[AutoSync] Failed to update L2 last error:', e) }
            }
          } else {
            for (const p of dedupedPending) {
              try { db.prepare('UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?').run(`HTTP ${l2Resp.status}`, p.id) } catch (e) { console.warn('[AutoSync] Failed to update L2 retry count:', e) }
            }
          }
        }

      } catch (err) {
        console.warn('[AutoSync] L2 cell sync error:', err instanceof Error ? err.message : err)
      }

      // Drain device-level blocker syncs (VFD bump-test failures) on the same
      // periodic cycle. The service applies the same transient/permanent
      // failure classification and retry-cap behaviour as the IO/L2 pushes.
      try {
        await getCloudSyncService().pushDeviceBlockerSyncs()
      } catch (err) {
        console.warn('[AutoSync] Device blocker sync error:', err instanceof Error ? err.message : err)
      }

      // Drain EStop EPC check results that never reached the cloud (offline at
      // the time of the write, or the immediate push failed). Subsystem-scoped,
      // version-aware; mirrors the L2 cell drain above.
      try {
        await this.pushEstopCheckSyncs(remoteUrl, apiPassword)
      } catch (err) {
        console.warn('[AutoSync] EStop check sync error:', err instanceof Error ? err.message : err)
      }

      // Drain Guided-Mode task-state overrides (skip / mark-done) that never
      // reached the cloud. Identity is (SubsystemId, TaskId); last-write-wins.
      try {
        await this.pushGuidedTaskStateSyncs(remoteUrl, apiPassword)
      } catch (err) {
        console.warn('[AutoSync] Guided task-state sync error:', err instanceof Error ? err.message : err)
      }

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this._lastPushResult = `error: ${msg}`
      console.warn(`[AutoSync] Push error: ${msg}`)
    } finally {
      this.isPushing = false
    }
  }

  /**
   * Background drain for EStop EPC check results (EStopCheckPendingSyncs).
   * Subsystem-scoped, version-aware. Dedupes to the OLDEST-version pending row
   * per (SubsystemId, ZoneName, CheckTag) — that's the base version the cloud
   * actually has — and pushes the LATEST local value. On success, drops all
   * pending rows for the check; on failure, leaves them for the next cycle and
   * applies a retry cap so an unrecoverable row can't wedge the queue forever.
   */
  private async pushEstopCheckSyncs(remoteUrl: string, apiPassword: string | undefined): Promise<void> {
    // CheckType ('preliminary' | 'final') is part of the identity — a row from
    // an old build may have it NULL/empty, treat that as 'preliminary'.
    const ct = (p: { CheckType: string | null }) => p.CheckType || 'preliminary'

    const readLatest = db.prepare(
      'SELECT Result, Comments, FailureMode, TestedBy, TestedAt, Version FROM EStopEpcChecks WHERE SubsystemId = ? AND ZoneName = ? AND CheckTag = ? AND CheckType = ?'
    )
    const deleteAllForCheck = db.prepare(
      'DELETE FROM EStopCheckPendingSyncs WHERE SubsystemId = ? AND ZoneName = ? AND CheckTag = ? AND CheckType = ?'
    )

    type EstopRow = SimpleQueueRow & {
      ZoneName: string; CheckTag: string; CheckType: string | null
      Result: string | null; Comments: string | null; FailureMode: string | null
      TestedBy: string | null; TestedAt: string | null; Version: number
    }

    await drainSimpleQueue<EstopRow>({
      db,
      tableName: 'EStopCheckPendingSyncs',
      retryCap: 10,
      remoteUrl,
      apiPassword,
      endpoint: '/api/sync/estop-checks',
      // Dedupe per check — keep the lowest Version (closest to cloud's real
      // version). Identity includes CheckType so preliminary + final for the
      // same EPC are tracked separately and never collapse into one.
      dedupeKey: p => `${p.SubsystemId}|${p.ZoneName}|${p.CheckTag}|${ct(p)}`,
      preferReplacement: (candidate, existing) => candidate.Version < existing.Version,
      buildBody: p => {
        const latest = readLatest.get(p.SubsystemId, p.ZoneName, p.CheckTag, ct(p)) as
          { Result: string | null; Comments: string | null; FailureMode: string | null; TestedBy: string | null; TestedAt: string | null; Version: number } | undefined
        return {
          subsystemId: p.SubsystemId,
          checks: [{
            zoneName: p.ZoneName,
            checkTag: p.CheckTag,
            checkType: ct(p),
            // Cloud /api/sync/estop-checks validates result ∈ {Passed,Failed};
            // the local EStop tables store lowercase pass/fail — normalize here.
            result: ((latest ? latest.Result : p.Result) === 'pass' ? 'Passed'
              : (latest ? latest.Result : p.Result) === 'fail' ? 'Failed'
              : (latest ? latest.Result : p.Result)),
            comments: latest ? latest.Comments : p.Comments,
            failureMode: latest ? latest.FailureMode : p.FailureMode,
            testedBy: latest ? latest.TestedBy : p.TestedBy,
            testedAt: latest ? latest.TestedAt : p.TestedAt,
            version: p.Version,
          }],
        }
      },
      deleteRowsForIdentity: p => { deleteAllForCheck.run(p.SubsystemId, p.ZoneName, p.CheckTag, ct(p)) },
      park: {
        // PARK, don't DELETE — e-stop results are SAFETY data. Deleting at the
        // cap left zero trace while the local UI still read "checked" (the
        // MCM11 silent-loss class). Keep the row (DeadLettered=1), out of the
        // active loop, and audit it for attention/recovery.
        defaultError: 'estop retry cap exhausted',
        auditReason: 'estop check retry cap exhausted',
        auditDetail: p => ({ zoneName: p.ZoneName, checkTag: p.CheckTag, checkType: ct(p), result: p.Result, retries: p.RetryCount }),
        logMessage: p => `[AutoSync] PARKED EStop check pending row id=${p.id} (${p.ZoneName}/${p.CheckTag}) — exceeded retry cap (kept for recovery)`,
      },
    })
  }

  /**
   * Background drain for Guided-Mode task-state overrides
   * (GuidedTaskStatePendingSyncs). Identity is (SubsystemId, TaskId); last-write
   * wins, so only the NEWEST pending row per task is pushed and the rest dropped.
   */
  private async pushGuidedTaskStateSyncs(remoteUrl: string, apiPassword: string | undefined): Promise<void> {
    const deleteAllForTask = db.prepare(
      'DELETE FROM GuidedTaskStatePendingSyncs WHERE SubsystemId = ? AND TaskId = ?'
    )

    type GuidedRow = SimpleQueueRow & {
      TaskId: string; Status: string
      Reason: string | null; ActorName: string | null; UpdatedAt: string | null
    }

    await drainSimpleQueue<GuidedRow>({
      db,
      tableName: 'GuidedTaskStatePendingSyncs',
      retryCap: 10,
      remoteUrl,
      apiPassword,
      endpoint: '/api/sync/guided-task-state',
      // Dedupe per task — keep the NEWEST row (highest id), drop older ones.
      dedupeKey: p => `${p.SubsystemId}|${p.TaskId}`,
      preferReplacement: (candidate, existing) => candidate.id > existing.id,
      buildBody: p => ({
        subsystemId: p.SubsystemId,
        states: [{
          taskId: p.TaskId,
          status: p.Status,
          reason: p.Reason,
          actorName: p.ActorName,
          updatedAt: p.UpdatedAt,
        }],
      }),
      deleteRowsForIdentity: p => { deleteAllForTask.run(p.SubsystemId, p.TaskId) },
      park: {
        // PARK, don't DELETE — keep the skip/complete override + reason for
        // recovery instead of silently dropping it at the cap.
        defaultError: 'guided task-state retry cap exhausted',
        auditReason: 'guided task-state retry cap exhausted',
        auditDetail: p => ({ taskId: p.TaskId, status: p.Status, retries: p.RetryCount }),
        logMessage: p => `[AutoSync] PARKED guided task-state pending row id=${p.id} (task ${p.TaskId}) — exceeded retry cap (kept for recovery)`,
      },
    })
  }

  /** Call after a manual Pull IOs to prevent auto-sync from overwriting with stale data */
  markManualPull(): void {
    this.pull.lastManualPullAt = Date.now()
  }

  private _lastReconcileAt = 0
  /**
   * Throttled orphan reconcile: re-enqueue local results/comments the cloud is
   * missing but that have no queue row (legacy/permanent drops). Closes the
   * "0 in queue but pull keeps warning" gap so offline→online delivery is
   * complete. Best-effort; on success it kicks an immediate push so recovered
   * orphans don't wait for the next tick.
   */
  private async reconcileOrphans(trigger: string): Promise<void> {
    const THROTTLE_MS = 2 * 60_000
    if (Date.now() - this._lastReconcileAt < THROTTLE_MS) return
    this._lastReconcileAt = Date.now()
    try {
      const results = await reconcileConfiguredSubsystems()
      const enqueued = results.reduce((n, r) => n + r.enqueued, 0)
      if (enqueued > 0) {
        console.warn(`[AutoSync] ${trigger}: reconciler re-enqueued ${enqueued} orphaned result/comment(s) for push`)
        this.pushToCloud()
      }
    } catch (e) {
      console.warn('[AutoSync] reconcile failed (non-fatal):', e instanceof Error ? e.message : e)
    }
  }

  /**
   * B7 reconcile — resolve `updatedCount=0` (version-conflict) pending rows
   * against CLOUD TRUTH instead of blind retries. See the call site in the
   * push loop for the full story (at-least-once ghosts under cloud-flap).
   * Includes already-PARKED rows of this class so historical ghosts heal too.
   * Throttled; fetches each affected subsystem's payload at most once per run.
   */
  private _lastB7ReconcileAt = 0
  private async reconcileVersionConflicts(): Promise<void> {
    // 2 min: drains run every ~10 s and a conflicted row strikes once per
    // drain. updatedCount=0 (at-least-once ghost) rows get 2× the retry cap
    // before parking, so this 2 min throttle still fires before they park.
    const THROTTLE_MS = 2 * 60_000
    if (Date.now() - this._lastB7ReconcileAt < THROTTLE_MS) return

    interface ConflictRow {
      id: number; IoId: number; TestResult: string | null; Comments: string | null
      Version: number; DeadLettered: number; SubsystemId: number | null
    }
    const rows = db.prepare(
      `SELECT ps.id, ps.IoId, ps.TestResult, ps.Comments, ps.Version, ps.DeadLettered, i.SubsystemId
         FROM PendingSyncs ps JOIN Ios i ON i.id = ps.IoId
        WHERE ps.LastError LIKE '%updatedCount=0%'
          AND (ps.DeadLettered = 1 OR ps.RetryCount >= 3)`
    ).all() as ConflictRow[]
    if (rows.length === 0) return
    this._lastB7ReconcileAt = Date.now()

    const config = await configService.getConfig()
    if (!config.remoteUrl || !config.apiPassword) return

    // One cloud fetch per affected subsystem (bounded).
    const subsystems = Array.from(new Set(rows.map(r => r.SubsystemId).filter((s): s is number => s != null))).slice(0, 6)
    const cloudByIo = new Map<number, { result: string | null; comments: string | null; version: number }>()
    for (const sid of subsystems) {
      try {
        const resp = await fetch(`${config.remoteUrl.replace(/\/$/, '')}/api/sync/subsystem/${sid}`, {
          headers: { 'X-API-Key': config.apiPassword },
          signal: AbortSignal.timeout(25_000),
        })
        if (!resp.ok) continue
        const data = await resp.json() as { ios?: Array<{ id: number; result?: string | null; comments?: string | null; version?: number }> }
        for (const io of data.ios ?? []) {
          cloudByIo.set(Number(io.id), {
            result: io.result ?? null,
            comments: io.comments ?? null,
            version: Number(io.version) || 0,
          })
        }
      } catch { /* unreachable cloud — try again next throttle window */ }
    }
    if (cloudByIo.size === 0) return

    // A cleared result lands as NULL in both stores.
    const norm = (v: string | null | undefined) => (v == null || v === '' || v === 'Cleared') ? null : v

    let applied = 0, superseded = 0, rebased = 0
    const delStmt = db.prepare('DELETE FROM PendingSyncs WHERE id = ?')
    const rebaseStmt = db.prepare(
      'UPDATE PendingSyncs SET Version = ?, RetryCount = 0, DeadLettered = 0, LastError = ? WHERE id = ?'
    )
    const newerStmt = db.prepare(
      'SELECT COUNT(*) AS cnt FROM PendingSyncs WHERE IoId = ? AND id > ? AND DeadLettered = 0'
    )
    for (const row of rows) {
      const cloud = cloudByIo.get(row.IoId)
      if (!cloud) continue
      if (norm(cloud.result) === norm(row.TestResult)) {
        // The push already landed (ack was lost) — nothing unsynced here.
        auditLog({
          type: 'sync.push.drop', ioId: row.IoId, subsystemId: row.SubsystemId, version: row.Version,
          result: row.TestResult, user: null,
          reason: 'b7-reconcile: cloud already has this value (at-least-once ghost)',
          detail: { pendingId: row.id, cloudVersion: cloud.version },
        })
        delStmt.run(row.id)
        applied++
      } else if ((newerStmt.get(row.IoId, row.id) as { cnt: number }).cnt > 0) {
        // A newer local write supersedes this row — it carries the newer value.
        auditLog({
          type: 'sync.push.drop', ioId: row.IoId, subsystemId: row.SubsystemId, version: row.Version,
          result: row.TestResult, user: null,
          reason: 'b7-reconcile: superseded by a newer pending row',
          detail: { pendingId: row.id },
        })
        delStmt.run(row.id)
        superseded++
      } else {
        // Cloud holds a DIFFERENT value. Before re-pushing this parked row, make
        // sure it STILL represents the local's CURRENT truth for the IO. A parked
        // INTERMEDIATE edit (an older "Comment Modified" / "Failed" that a LATER
        // local edit has since superseded) must NOT be re-pushed — under the
        // cloud's last-write-wins it would clobber newer cloud state and make the
        // result flip back (the FL1085_2_FIOM1_X1.I.5 flip-flop). Only the row
        // whose payload still matches the live Ios value is the real local truth
        // and worth rebasing; any stale snapshot is dropped instead.
        const localIo = db.prepare('SELECT Result, Comments FROM Ios WHERE id = ?').get(row.IoId) as { Result: string | null; Comments: string | null } | undefined
        const ncmt = (v: string | null | undefined) => (v == null || v.trim() === '') ? null : v.trim()
        const isCommentOp = /comment/i.test(row.TestResult || '')
        const matchesLocalTruth = !!localIo && (
          isCommentOp
            ? ncmt(localIo.Comments) === ncmt(row.Comments)   // comment ops only carry the comment
            : norm(localIo.Result) === norm(row.TestResult)   // result ops carry the result
        )
        if (!matchesLocalTruth) {
          // Stale intermediate — a newer local edit already supersedes this row's
          // value. Drop it (don't rebase) so it can't re-push old text over the
          // fresher cloud state.
          auditLog({
            type: 'sync.push.drop', ioId: row.IoId, subsystemId: row.SubsystemId, version: row.Version,
            result: row.TestResult, user: null,
            reason: 'b7-reconcile: dropped stale parked row (superseded by newer local value; not re-pushed)',
            detail: { pendingId: row.id, cloudResult: cloud.result, localResult: localIo?.Result ?? null },
          })
          delStmt.run(row.id)
          superseded++
        } else {
          // This row IS the local truth and cloud differs → rebase to cloud's
          // version so the next push applies last-write-wins, and clear strikes/park.
          rebaseStmt.run(cloud.version, `b7-rebased from v${row.Version} to cloud v${cloud.version}`, row.id)
          auditLog({
            type: 'sync.push.drop', ioId: row.IoId, subsystemId: row.SubsystemId, version: row.Version,
            result: row.TestResult, user: null,
            reason: `b7-reconcile: rebased to cloud v${cloud.version} (will re-push, local wins)`,
            detail: { pendingId: row.id, cloudResult: cloud.result },
          })
          rebased++
        }
      }
    }
    if (applied + superseded + rebased > 0) {
      console.log(
        `[AutoSync] B7 reconcile: ${applied} already-applied ghost(s) cleared, ` +
        `${superseded} superseded row(s) cleared, ${rebased} rebased for re-push ` +
        `(${rows.length} conflicted row(s) examined across ${subsystems.length} subsystem(s))`
      )
    }
  }

}

// Singleton
let autoSyncInstance: AutoSyncService | null = null

export function getAutoSyncService(): AutoSyncService | null {
  return autoSyncInstance
}

export function startAutoSync(config?: Partial<AutoSyncConfig>): AutoSyncService {
  if (autoSyncInstance && autoSyncInstance.running) {
    // Already running — don't restart (preserves SSE connection)
    return autoSyncInstance
  }
  if (autoSyncInstance) {
    autoSyncInstance.stop()
  }
  autoSyncInstance = new AutoSyncService(config)
  autoSyncInstance.start()
  return autoSyncInstance
}

export function stopAutoSync(): void {
  if (autoSyncInstance) {
    autoSyncInstance.stop()
    autoSyncInstance = null
  }
}
