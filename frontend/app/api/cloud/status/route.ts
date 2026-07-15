import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'
import { getAutoSyncService } from '@/lib/cloud/auto-sync'
import { configService } from '@/lib/config'
import { resolveBackupsDirPath, resolveDatabasePath } from '@/lib/storage-paths'
import type { CloudSyncStatusResponse } from '@/lib/cloud/types'

export async function GET(req: Request, res: Response) {
  try {
    // ── ONE definition of pending vs parked ────────────────────────────
    // These counts MUST match lib/sync/queue-inspector.ts (the source the Sync
    // Center page + nav badge read via /api/sync/queue). The split is fixed:
    //   pending / active = DeadLettered = 0  (auto-sync will keep retrying)
    //   parked / attention = DeadLettered = 1 (stopped retrying — needs a human)
    // Both queries below apply the SAME DeadLettered filter so the toolbar pill
    // and the cloud-sync-dialog can never disagree with the nav badge.
    //
    // safeCount tolerates a missing table on an older DB (mirrors the per-table
    // try/catch in queue-inspector) so a fresh install never 500s this route.
    const safeCount = (sql: string): number => {
      try { return (db.prepare(sql).get() as { cnt: number }).cnt } catch { return 0 }
    }

    // Active queue = retryable work still owed to cloud (DeadLettered = 0).
    const pendingIoSyncCount = safeCount('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE DeadLettered = 0')
    const pendingL2SyncCount = safeCount('SELECT COUNT(*) as cnt FROM L2PendingSyncs WHERE DeadLettered = 0')
    const pendingChangeRequestCount = safeCount("SELECT COUNT(*) as cnt FROM ChangeRequests WHERE Status = 'pending' AND CloudId IS NULL")
    const totalPendingCount = pendingIoSyncCount + pendingL2SyncCount + pendingChangeRequestCount
    // Parked rows: results the cloud REJECTED or that exhausted retries — they
    // left the active queue but are NOT on cloud. Surfaced so the indicator
    // never reads "all synced" while field work is actually stuck (B3/B5).
    // Parked = DeadLettered = 1 across ALL THREE outbound queue tables — the
    // SAME set + filter as queue-inspector's summary.parked. Counting IO-only
    // here (the old bug) let a parked L2/blocker row light the red nav badge
    // while this route reported 0 attention → toolbar stayed green.
    const attentionCount =
      safeCount('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE DeadLettered = 1')
      + safeCount('SELECT COUNT(*) as cnt FROM L2PendingSyncs WHERE DeadLettered = 1')
      + safeCount('SELECT COUNT(*) as cnt FROM DeviceBlockerPendingSyncs WHERE DeadLettered = 1')

    // ── Per-MCM (per-subsystem) breakdown ──────────────────────────────
    // On a CENTRAL server one tool owns many MCMs, so the global totals above
    // can't tell the operator WHICH subsystem has stuck/unsynced/rejected work.
    // We re-derive the same counts grouped by subsystem via JOINs:
    //   PendingSyncs.IoId           → Ios.SubsystemId
    //   L2PendingSyncs.CloudDeviceId → L2Devices.CloudId → L2Devices.Subsystem
    // L2Devices has no numeric SubsystemId column (only the Subsystem name),
    // so L2 work is keyed by that name; a parked L2 row whose device row is
    // gone buckets as 'unknown'. Counting semantics are IDENTICAL to the
    // globals — this only adds grouping. Single-MCM tablets just see one entry.
    interface PerSubsystemCounts {
      subsystemId: string
      pendingIoSyncCount: number
      pendingL2SyncCount: number
      attentionCount: number
      failedIoSyncCount: number
      pullBlocked: boolean
    }
    const perSubsystemMap = new Map<string, PerSubsystemCounts>()
    const bucket = (key: string | number | null | undefined): PerSubsystemCounts => {
      const k = key == null ? 'unknown' : String(key)
      let entry = perSubsystemMap.get(k)
      if (!entry) {
        entry = { subsystemId: k, pendingIoSyncCount: 0, pendingL2SyncCount: 0, attentionCount: 0, failedIoSyncCount: 0, pullBlocked: false }
        perSubsystemMap.set(k, entry)
      }
      return entry
    }

    // IO pending (active queue): group by the owning IO's subsystem.
    const ioPendingRows = db.prepare(`
      SELECT i.SubsystemId AS sid, COUNT(*) AS cnt
      FROM PendingSyncs p LEFT JOIN Ios i ON i.id = p.IoId
      WHERE p.DeadLettered = 0
      GROUP BY i.SubsystemId
    `).all() as { sid: number | null; cnt: number }[]
    for (const r of ioPendingRows) bucket(r.sid).pendingIoSyncCount = r.cnt

    // IO parked (DeadLettered=1) → attention, per subsystem.
    const ioAttentionRows = db.prepare(`
      SELECT i.SubsystemId AS sid, COUNT(*) AS cnt
      FROM PendingSyncs p LEFT JOIN Ios i ON i.id = p.IoId
      WHERE p.DeadLettered = 1
      GROUP BY i.SubsystemId
    `).all() as { sid: number | null; cnt: number }[]
    for (const r of ioAttentionRows) bucket(r.sid).attentionCount = r.cnt

    // IO failed (RetryCount > 0), per subsystem.
    const ioFailedRows = db.prepare(`
      SELECT i.SubsystemId AS sid, COUNT(*) AS cnt
      FROM PendingSyncs p LEFT JOIN Ios i ON i.id = p.IoId
      WHERE p.RetryCount > 0
      GROUP BY i.SubsystemId
    `).all() as { sid: number | null; cnt: number }[]
    for (const r of ioFailedRows) bucket(r.sid).failedIoSyncCount = r.cnt

    // L2 pending: resolve subsystem through the device row's Subsystem name.
    // Active only (DeadLettered = 0) — matches the global pendingL2SyncCount
    // above (both now exclude parked rows) so per-MCM pullBlocked agrees with
    // the global total.
    const l2PendingRows = db.prepare(`
      SELECT d.Subsystem AS sub, COUNT(*) AS cnt
      FROM L2PendingSyncs lp LEFT JOIN L2Devices d ON d.CloudId = lp.CloudDeviceId
      WHERE lp.DeadLettered = 0
      GROUP BY d.Subsystem
    `).all() as { sub: string | null; cnt: number }[]
    for (const r of l2PendingRows) bucket(r.sub).pendingL2SyncCount = r.cnt

    for (const entry of Array.from(perSubsystemMap.values())) {
      entry.pullBlocked = (entry.pendingIoSyncCount + entry.pendingL2SyncCount) > 0
    }
    const perSubsystem = Array.from(perSubsystemMap.values())

    const cloudSyncService = getCloudSyncService()
    const config = await cloudSyncService.getConfig()
    const autoSyncService = getAutoSyncService()
    const autoSyncStatus = autoSyncService ? autoSyncService.getStatus() : null

    let connected = false
    let error: string | undefined

    const sseClient = getCloudSseClient()
    if (sseClient) {
      connected = sseClient.isConnected
      if (!connected && sseClient.connectionState === 'reconnecting') {
        error = 'Reconnecting to cloud...'
      } else if (!connected && sseClient.connectionState === 'auth-failed') {
        error = 'Cloud AUTH FAILED — the API key was rejected. Check the API password / project assignment.'
      }
    } else if (config.remoteUrl) {
      try {
        connected = await cloudSyncService.isCloudAvailable()
        if (connected) {
          cloudSyncService.setConnectionState('connected')
        }
      } catch (e) {
        error = e instanceof Error ? e.message : 'Connection check failed'
      }
    } else {
      error = 'Remote URL not configured'
    }

    const failedIoSyncCount = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE RetryCount > 0').get() as { cnt: number }).cnt
    const failedL2SyncCount = (db.prepare('SELECT COUNT(*) as cnt FROM L2PendingSyncs WHERE RetryCount > 0').get() as { cnt: number }).cnt
    const oldestIoRow = db.prepare('SELECT CreatedAt FROM PendingSyncs ORDER BY CreatedAt ASC LIMIT 1').get() as { CreatedAt: string } | undefined
    const oldestL2Row = db.prepare('SELECT CreatedAt FROM L2PendingSyncs ORDER BY CreatedAt ASC LIMIT 1').get() as { CreatedAt: string } | undefined
    const oldestChangeRequestRow = db.prepare("SELECT CreatedAt FROM ChangeRequests WHERE Status = 'pending' AND CloudId IS NULL ORDER BY CreatedAt ASC LIMIT 1").get() as { CreatedAt: string } | undefined
    const dirtyQueues = [
      pendingIoSyncCount > 0 ? 'io' : null,
      pendingL2SyncCount > 0 ? 'l2' : null,
      pendingChangeRequestCount > 0 ? 'change-requests' : null,
    ].filter(Boolean) as string[]

    return res.json({
      connected,
      connectionState: sseClient?.connectionState ?? cloudSyncService.connectionState,
      pendingSyncCount: pendingIoSyncCount,
      pendingIoSyncCount,
      pendingL2SyncCount,
      pendingChangeRequestCount,
      totalPendingCount,
      attentionCount,
      perSubsystem,
      failedIoSyncCount,
      failedL2SyncCount,
      oldestPendingIoSync: oldestIoRow?.CreatedAt ?? undefined,
      oldestPendingL2Sync: oldestL2Row?.CreatedAt ?? undefined,
      oldestPendingChangeRequest: oldestChangeRequestRow?.CreatedAt ?? undefined,
      lastSyncAttempt: oldestIoRow?.CreatedAt ?? oldestL2Row?.CreatedAt ?? oldestChangeRequestRow?.CreatedAt ?? undefined,
      pullBlocked: totalPendingCount > 0,
      dirtyQueues,
      autoSyncRunning: autoSyncStatus?.running ?? false,
      lastPushAt: autoSyncStatus?.lastPushAt ?? undefined,
      lastPullAt: autoSyncStatus?.lastPullAt ?? undefined,
      lastPushResult: autoSyncStatus?.lastPushResult ?? undefined,
      lastPullResult: autoSyncStatus?.lastPullResult ?? undefined,
      configPath: configService.getConfigFilePath(),
      databasePath: resolveDatabasePath(),
      backupsPath: resolveBackupsDirPath(),
      error,
    } as CloudSyncStatusResponse)
  } catch (error) {
    console.error('[CloudStatus] Error getting cloud status:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    // B8: do NOT assert "0 pending" when we failed to read status — that reads
    // as "all synced". Mark the count unknown so the UI shows an error state.
    return res.json({ connected: false, pendingSyncCount: 0, statusUnknown: true, error: errorMessage } as CloudSyncStatusResponse)
  }
}

export async function POST(req: Request, res: Response) {
  try {
    const body = req.body || {}
    const { remoteUrl, apiPassword, subsystemId } = body

    const cloudSyncService = getCloudSyncService()

    if (remoteUrl || apiPassword || subsystemId) {
      await cloudSyncService.updateConfig({
        ...(remoteUrl && { remoteUrl }),
        ...(apiPassword && { apiPassword }),
        ...(subsystemId && { subsystemId }),
      })
    }

    let connected = false
    let error: string | undefined

    const config = await cloudSyncService.getConfig()

    if (config.remoteUrl) {
      try {
        connected = await cloudSyncService.isCloudAvailable()
        if (!connected) {
          error = 'Cloud server is not reachable'
        }
      } catch (e) {
        error = e instanceof Error ? e.message : 'Connection test failed'
        connected = false
      }
    } else {
      error = 'Remote URL not configured'
    }

    // ACTIVE rows only — parked (DeadLettered=1) rows are "attention", not
    // pending work (consistent with the GET handler + toolbar split).
    const pendingSyncCount = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE DeadLettered = 0').get() as { cnt: number }).cnt

    return res.json({ connected, pendingSyncCount, error } as CloudSyncStatusResponse)
  } catch (error) {
    console.error('[CloudStatus] Error updating cloud status:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ connected: false, pendingSyncCount: 0, error: errorMessage } as CloudSyncStatusResponse)
  }
}
