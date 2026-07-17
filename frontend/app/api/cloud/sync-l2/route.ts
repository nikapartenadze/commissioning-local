import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { manualSyncFailureUpdate } from '@/lib/cloud/manual-sync-failure'

/**
 * POST /api/cloud/sync-l2
 *
 * Manual trigger to push all pending L2 (Functional Validation) cell changes
 * to cloud. Same logic as the auto-sync background retry, but on-demand so
 * operators can flush the queue without waiting for the 30-second interval.
 */
export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    if (!remoteUrl) {
      return res.json({
        success: false,
        syncedCount: 0,
        failedCount: 0,
        errors: ['Cloud URL not configured'],
      })
    }

    // Only ACTIVE rows (DeadLettered = 0). A parked row already exhausted its
    // retries / was rejected — a manual "Sync now" must not silently re-attempt
    // it (and re-strike it); parked rows are recovered explicitly via Sync Center.
    const l2Pending = db.prepare(
      'SELECT * FROM L2PendingSyncs WHERE DeadLettered = 0 ORDER BY CreatedAt ASC LIMIT 200'
    ).all() as any[]

    if (l2Pending.length === 0) {
      return res.json({ success: true, syncedCount: 0, failedCount: 0 })
    }

    console.log(`[L2 Sync] Manual sync triggered — ${l2Pending.length} pending items`)

    // Deduplicate: if multiple pending syncs exist for the same cell, keep the
    // one with the LOWEST Version (closest to what cloud actually has). Delete rest.
    const cellMap = new Map<string, any>()
    const stalePendingIds: number[] = []
    for (const p of l2Pending) {
      const key = `${p.CloudDeviceId}-${p.CloudColumnId}`
      const existing = cellMap.get(key)
      if (!existing) {
        cellMap.set(key, p)
      } else {
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
      console.log(`[L2 Sync] Deduplicated: removed ${stalePendingIds.length} stale rows`)
    }

    const dedupedPending = Array.from(cellMap.values())

    // Read latest local VALUE but use stored pending Version as the base.
    // Using local.Version - 1 would break when multiple edits happened while
    // previous pushes were failing — the local version jumps ahead but cloud hasn't moved.
    const getLocalCell = db.prepare(`
      SELECT cv.Value, cv.UpdatedBy
      FROM L2CellValues cv
      JOIN L2Devices d ON d.id = cv.DeviceId
      JOIN L2Columns c ON c.id = cv.ColumnId
      WHERE d.CloudId = ? AND c.CloudId = ?
    `)

    const l2Updates = dedupedPending.map((p: any) => {
      const local = getLocalCell.get(p.CloudDeviceId, p.CloudColumnId) as { Value: string | null; UpdatedBy: string | null } | undefined
      return {
        pendingId: p.id,
        deviceId: p.CloudDeviceId,
        columnId: p.CloudColumnId,
        value: local ? local.Value : p.Value,       // latest local value
        version: p.Version,                          // stored base version (what cloud has)
        updatedBy: local?.UpdatedBy || p.UpdatedBy,
      }
    })

    // Push in batches of 50 to avoid huge payloads
    let totalSynced = 0
    let totalFailed = 0
    const errors: string[] = []

    for (let i = 0; i < l2Updates.length; i += 50) {
      const batch = l2Updates.slice(i, i + 50)

      let l2Resp: globalThis.Response
      try {
        l2Resp = await fetch(`${remoteUrl}/api/sync/l2/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword || '' },
          body: JSON.stringify({ updates: batch.map(({ pendingId, ...rest }) => rest) }),
          signal: AbortSignal.timeout(30000),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const { lastError } = manualSyncFailureUpdate({ thrown: true, message: msg })
        console.warn(`[L2 Sync] Network error on batch ${i / 50 + 1}:`, msg)
        errors.push(`Network error: ${msg}`)
        totalFailed += batch.length
        // Network-level (the cloud never ruled on these rows) — NO strike.
        for (const u of batch) {
          try { db.prepare('UPDATE L2PendingSyncs SET LastError = ? WHERE id = ?').run(lastError, u.pendingId) } catch { /* ignore */ }
        }
        continue
      }

      if (l2Resp.status === 401) {
        const { lastError } = manualSyncFailureUpdate({ httpStatus: 401 })
        console.warn('[L2 Sync] Auth failure (401) — check API password in config')
        errors.push('Authentication failed (401) — check cloud API password')
        totalFailed += batch.length
        // 401 is an auth/config problem on the tool, NOT a verdict on the rows —
        // NO strike (the 2026-06-04 TPA8/MCM08 lesson).
        for (const u of batch) {
          try { db.prepare('UPDATE L2PendingSyncs SET LastError = ? WHERE id = ?').run(lastError, u.pendingId) } catch { /* ignore */ }
        }
        break // Don't bother sending more batches with bad auth
      }

      if (!l2Resp.ok) {
        const { strike, lastError } = manualSyncFailureUpdate({ httpStatus: l2Resp.status })
        console.warn(`[L2 Sync] HTTP ${l2Resp.status} on batch ${i / 50 + 1}${strike ? '' : ' (network-level, no strike)'}`)
        errors.push(`Cloud returned HTTP ${l2Resp.status}`)
        totalFailed += batch.length
        // Only a genuine cloud verdict (a non-network 4xx) burns a strike; 429 /
        // 5xx are transient and must NOT march a healthy row toward the park cap.
        const sql = strike
          ? 'UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?'
          : 'UPDATE L2PendingSyncs SET LastError = ? WHERE id = ?'
        for (const u of batch) {
          try { db.prepare(sql).run(lastError, u.pendingId) } catch { /* ignore */ }
        }
        continue
      }

      const l2Data = await l2Resp.json().catch(() => null) as any
      const updatedKeys = new Set(
        (l2Data?.updates || []).map((u: any) => `${u.deviceId}-${u.columnId}`)
      )

      // Delete ALL pending rows for successful cells (not just the one we pushed)
      const deleteAllForCell = db.prepare('DELETE FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ?')
      let batchSynced = 0
      for (const u of batch) {
        if (updatedKeys.has(`${u.deviceId}-${u.columnId}`)) {
          deleteAllForCell.run(u.deviceId, u.columnId)
          batchSynced++
        }
      }
      totalSynced += batchSynced

      // For conflicts: rebase pending row's Version to cloud's current version so
      // the next push lands. The cloud's value-match short-circuit already handled
      // the lost-ACK case, so reaching this branch means values genuinely differ
      // and local is authoritative per CLAUDE.md.
      const conflictsByKey = new Map<string, number>()
      for (const c of (l2Data?.conflicts || []) as Array<{ deviceId: number; columnId: number; cloudVersion: number }>) {
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
        `UPDATE L2PendingSyncs SET Version = ?, RetryCount = RetryCount + 1, LastError = ? WHERE CloudDeviceId = ? AND CloudColumnId = ?`
      )
      const incrementStmt = db.prepare(
        'UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?'
      )

      const conflicted = batch.filter(u => !updatedKeys.has(`${u.deviceId}-${u.columnId}`))
      totalFailed += conflicted.length
      let rebasedCount = 0
      for (const u of conflicted) {
        const cloudVersion = conflictsByKey.get(`${u.deviceId}-${u.columnId}`)
        if (typeof cloudVersion === 'number') {
          try {
            rebaseStmt.run(cloudVersion, 'rebased after version conflict', u.deviceId, u.columnId)
            rebasedCount++
          } catch { /* ignore */ }
        } else {
          try { incrementStmt.run('version conflict (no cloudVersion)', u.pendingId) } catch { /* ignore */ }
        }
      }
      if (conflicted.length > 0) {
        errors.push(`${conflicted.length} version conflicts (${rebasedCount} rebased — retry to clear)`)
      }
    }

    // Track SSE pushed IDs to avoid echo
    if (totalSynced > 0) {
      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        const sseClient = getCloudSseClient()
        if (sseClient) {
          for (const u of l2Updates) {
            sseClient.trackPushedL2Id(u.deviceId, u.columnId)
          }
        }
      } catch { /* non-critical */ }
    }

    console.log(`[L2 Sync] Manual sync complete: ${totalSynced} synced, ${totalFailed} failed`)

    return res.json({
      success: totalFailed === 0,
      syncedCount: totalSynced,
      failedCount: totalFailed,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error('[L2 Sync] Error processing manual L2 sync:', error)
    return res.status(500).json({
      success: false,
      syncedCount: 0,
      failedCount: 0,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
    })
  }
}

/**
 * GET /api/cloud/sync-l2
 *
 * Returns the current state of the L2 pending sync queue.
 */
export async function GET(req: Request, res: Response) {
  try {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN RetryCount > 0 THEN 1 ELSE 0 END) as retried,
        MAX(RetryCount) as maxRetries,
        MIN(CreatedAt) as oldestTimestamp
      FROM L2PendingSyncs
    `).get() as { total: number; retried: number; maxRetries: number | null; oldestTimestamp: string | null }

    return res.json({
      pendingCount: stats.total,
      retriedCount: stats.retried,
      maxRetries: stats.maxRetries ?? 0,
      oldestPending: stats.oldestTimestamp ?? null,
    })
  } catch (error) {
    console.error('[L2 Sync] Error getting L2 sync status:', error)
    return res.status(500).json({ error: 'Failed to get L2 sync status' })
  }
}
