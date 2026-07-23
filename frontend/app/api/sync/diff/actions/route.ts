import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types'
import { auditLog } from '@/lib/logging/recovery-log'
import { sendHeartbeat } from '@/lib/heartbeat/heartbeat-service'

/**
 * Fire a heartbeat so the cloud's fleet pending-count reflects this action
 * immediately — a push ADDS active PendingSyncs rows, accept_cloud/tombstone
 * DROP them, and the heartbeat carries that live count. Without this the fleet
 * view lags a full auto-sync tick (~10 s). sendHeartbeat already never throws
 * and self-bounds to 10 s; we additionally cap the wait so a slow heartbeat
 * can't stall the action's HTTP response, and swallow everything — a heartbeat
 * must NEVER fail the action it is reporting.
 */
async function refreshCloudPresence(): Promise<void> {
  try {
    await Promise.race([
      sendHeartbeat(),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ])
  } catch { /* best-effort — a heartbeat failure never fails the action */ }
}

/**
 * POST /api/sync/diff/actions
 *   { action: 'push' | 'accept_cloud' | 'tombstone', subsystemId: number, ids: number[] }
 *
 * Resolve one class of Sync-Diff divergence for the selected IOs:
 *  - push         → re-queue the local result/comment for upload (local wins).
 *  - accept_cloud → overwrite the (stale) local value with the cloud value and
 *                   drop any queued push — "clear the old local version".
 *  - tombstone    → mark a removed-on-cloud IO as accepted (CloudRemoved=1) so it
 *                   stops warning and stops being re-queued; drop its queue rows.
 *
 * DATA SAFETY: push never mutates Ios. accept_cloud overwrites the local Result/
 * Comments/Version with the AUTHORITATIVE cloud value (re-fetched here, not
 * trusted from the client) — the operator explicitly asked to take cloud for a
 * stale row, and a TestHistory audit trail row is written first. tombstone is a
 * sync-state flag only. Every accept_cloud takes a per-op backup on first use.
 */

interface CloudIo { id: number | string; result?: string | null; comments?: string | null; version?: number }

export async function POST(req: Request, res: Response) {
  try {
    const body = (req.body || {}) as { action?: string; subsystemId?: number; ids?: number[] }
    const action = body.action
    const subsystemId = Number(body.subsystemId)
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n)) : []

    if (action !== 'push' && action !== 'accept_cloud' && action !== 'tombstone') {
      return res.status(400).json({ success: false, error: "action must be 'push' | 'accept_cloud' | 'tombstone'" })
    }
    if (!Number.isFinite(subsystemId) || subsystemId <= 0) return res.status(400).json({ success: false, error: 'subsystemId required' })
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'ids required' })

    // ── tombstone: local-only, no cloud fetch needed ──
    if (action === 'tombstone') {
      const stmt = db.prepare('UPDATE Ios SET CloudRemoved = 1 WHERE id = ? AND SubsystemId = ?')
      const delQ = db.prepare('DELETE FROM PendingSyncs WHERE IoId = ?')
      let affected = 0
      const run = db.transaction((rows: number[]) => {
        for (const id of rows) { affected += stmt.run(id, subsystemId).changes; delQ.run(id) }
      })
      run(ids)
      auditLog({ type: 'sync.diff.tombstone', subsystemId, detail: { ids, affected } })
      await refreshCloudPresence()
      return res.json({ success: true, action, affected, message: `Accepted ${affected} removed-on-cloud IO(s) — they will stop warning.` })
    }

    // push + accept_cloud need the authoritative cloud payload.
    const cfg = await configService.getConfig()
    const remoteUrl = (cfg.remoteUrl || EMBEDDED_REMOTE_URL).replace(/\/+$/, '')
    const apiPassword = cfg.apiPassword || ''
    if (!remoteUrl || !apiPassword) return res.status(400).json({ success: false, error: 'Cloud URL / API key not configured' })

    let cloudById = new Map<number, CloudIo>()
    try {
      const r = await fetch(`${remoteUrl}/api/sync/subsystem/${subsystemId}`, { method: 'GET', headers: { 'X-API-Key': apiPassword }, signal: AbortSignal.timeout(25_000) })
      if (!r.ok) return res.status(502).json({ success: false, error: `Cloud returned ${r.status}` })
      const b = await r.json()
      const arr = (b.ios || b.Ios || []) as CloudIo[]
      cloudById = new Map(arr.map((c) => [Number(c.id), c]))
    } catch (err) {
      return res.status(502).json({ success: false, error: `Cloud unreachable: ${err instanceof Error ? err.message : String(err)}` })
    }

    const idSet = new Set(ids)
    const locals = db.prepare(
      `SELECT id, Name, Result, Comments, TestedBy, Timestamp, Version, Trade, FailureMode
         FROM Ios WHERE SubsystemId = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ).all(subsystemId, ...ids) as Array<{ id: number; Name: string; Result: string | null; Comments: string | null; TestedBy: string | null; Timestamp: string | null; Version: number; Trade: string | null; FailureMode: string | null }>

    if (action === 'push') {
      // Re-queue each local result/comment with the cloud's CURRENT version as
      // base (max first-try acceptance; the drain rebases on any miss, local-wins).
      const hasPending = db.prepare('SELECT 1 FROM PendingSyncs WHERE IoId = ? LIMIT 1')
      const ins = db.prepare(
        `INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, CreatedAt, RetryCount, Version, FailureMode, Trade)
         VALUES (@IoId, @InspectorName, @TestResult, @Comments, NULL, @Timestamp, @CreatedAt, 0, @Version, @FailureMode, @Trade)`,
      )
      const now = new Date().toISOString()
      let queued = 0
      const run = db.transaction((rows: typeof locals) => {
        for (const l of rows) {
          if (hasPending.get(l.id)) continue // already queued — don't duplicate
          const cloudVer = Number(cloudById.get(l.id)?.version) || 0
          const testResult = (l.Result && l.Result.trim() !== '') ? l.Result : 'Comment Added'
          ins.run({ IoId: l.id, InspectorName: l.TestedBy, TestResult: testResult, Comments: l.Comments, Timestamp: l.Timestamp, CreatedAt: now, Version: cloudVer, FailureMode: l.FailureMode, Trade: l.Trade })
          queued++
        }
      })
      run(locals)
      auditLog({ type: 'sync.diff.push', subsystemId, detail: { ids: locals.map((l) => l.id), queued } })
      await refreshCloudPresence()
      return res.json({ success: true, action, affected: queued, message: `Queued ${queued} local result(s) for upload.` })
    }

    // action === 'accept_cloud': overwrite stale local with the cloud value.
    let backupTaken = false
    const histIns = db.prepare(
      'INSERT INTO TestHistories (IoId, Result, Timestamp) VALUES (?, ?, ?)',
    )
    const upd = db.prepare('UPDATE Ios SET Result = ?, Comments = ?, Version = ?, CloudRemoved = 0 WHERE id = ? AND SubsystemId = ?')
    const delQ = db.prepare('DELETE FROM PendingSyncs WHERE IoId = ?')
    const now = new Date().toISOString()
    let affected = 0
    // A per-op DB backup on first accept — accept overwrites a local value, so
    // keep a recovery point (mirrors the destructive-pull guard's backup).
    if (!backupTaken) {
      try { const { createBackup } = await import('@/lib/db/backup'); await createBackup('before-accept-cloud'); backupTaken = true } catch (e) { console.warn('[SyncDiff] accept-cloud backup failed (proceeding):', e) }
    }
    const run = db.transaction((rows: number[]) => {
      for (const id of rows) {
        const c = cloudById.get(id)
        if (!c) continue // cloud no longer has it — not an accept target
        const cloudResult = c.result ?? null
        const cloudComments = c.comments ?? null
        const cloudVer = Number(c.version) || 0
        // Audit the pre-accept local value so the overwrite is recoverable.
        const before = db.prepare('SELECT Result FROM Ios WHERE id = ?').get(id) as { Result?: string } | undefined
        histIns.run(id, `accept-cloud: local "${before?.Result ?? ''}" → cloud "${cloudResult ?? ''}"`, now)
        affected += upd.run(cloudResult, cloudComments, cloudVer, id, subsystemId).changes
        delQ.run(id) // we accepted cloud — drop any queued local push
      }
    })
    run(ids.filter((id) => idSet.has(id)))
    auditLog({ type: 'sync.diff.accept_cloud', subsystemId, detail: { ids, affected, backup: backupTaken } })
    await refreshCloudPresence()
    return res.json({ success: true, action, affected, message: `Accepted the cloud value for ${affected} IO(s); the stale local copy was replaced.` })
  } catch (error) {
    console.error('Sync diff action failed:', error)
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Internal error' })
  }
}
