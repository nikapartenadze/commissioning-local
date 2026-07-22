import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types'
import { createBackup } from '@/lib/db/backup'
import { auditLog } from '@/lib/logging/recovery-log'

/**
 * POST /api/cloud/push-force   body: { ioId } | { subsystemId, all: true }
 *
 * Operator force-overwrite: push "stuck" local results to the cloud even though
 * the cloud version ran past the tablet's base (which is why they parked). The
 * cloud accepts these because the payload carries `force: true` (opt-in; the
 * cloud's version gate is bypassed only for forced updates — op validity + SPARE
 * rules still apply). This is a DELIBERATE, confirmed action, not automatic.
 *
 * Safety: a full pre-force DB backup is taken first; every attempt is written to
 * the recovery log (sync.push.force); the cloud writes a testhistory row + a
 * force_overwrite audit entry on its side. On success the local PendingSync row
 * is cleared. Nothing is deleted on failure.
 */
interface StuckRow {
  id: number
  IoId: number
  TestResult: string | null
  Comments: string | null
  State: string | null
  Version: number | null
  InspectorName: string | null
}

export async function POST(req: Request, res: Response) {
  try {
    const ioId = req.body?.ioId != null ? parseInt(String(req.body.ioId), 10) : null
    const subsystemId = req.body?.subsystemId != null ? parseInt(String(req.body.subsystemId), 10) : null
    const all = req.body?.all === true

    if (!ioId && !(subsystemId && all)) {
      return res.status(400).json({ success: false, error: 'Provide { ioId } or { subsystemId, all: true }' })
    }

    // Target the stuck rows (parked OR failed) for one IO, or all in a subsystem.
    const rows = (ioId
      ? db.prepare(
          `SELECT id, IoId, TestResult, Comments, State, Version, InspectorName
           FROM PendingSyncs WHERE IoId = ? AND Resolved = 0 AND (DeadLettered = 1 OR RetryCount > 0)
           ORDER BY CreatedAt ASC`,
        ).all(ioId)
      : db.prepare(
          `SELECT ps.id, ps.IoId, ps.TestResult, ps.Comments, ps.State, ps.Version, ps.InspectorName
           FROM PendingSyncs ps JOIN Ios i ON i.id = ps.IoId
           WHERE i.SubsystemId = ? AND ps.Resolved = 0 AND (ps.DeadLettered = 1 OR ps.RetryCount > 0)
           ORDER BY ps.CreatedAt ASC`,
        ).all(subsystemId)) as StuckRow[]

    if (rows.length === 0) {
      return res.json({ success: true, forced: 0, failed: 0, message: 'No stuck sync rows to force' })
    }

    const cfg = await configService.getConfig()
    const remoteUrl = (cfg.remoteUrl || EMBEDDED_REMOTE_URL).replace(/\/$/, '')
    const apiPassword = cfg.apiPassword || ''
    if (!apiPassword) {
      return res.status(400).json({ success: false, error: 'No API password configured' })
    }

    // Pre-force safety backup (abort if it fails — same rail as pulls).
    try {
      const backup = await createBackup('pre-force-push')
      console.log(`[PushForce] Backup created: ${backup.filename}`)
    } catch (backupErr) {
      console.error('[PushForce] Pre-force backup FAILED — aborting:', backupErr)
      return res.status(500).json({ success: false, error: 'Pre-force backup failed — aborted to protect local data.' })
    }

    const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiPassword }
    let forced = 0
    let failed = 0
    const results: Array<{ ioId: number; ok: boolean; error?: string }> = []

    for (const row of rows) {
      const update = {
        id: row.IoId,
        version: Number(row.Version) || 0,
        result: row.TestResult,
        comments: row.Comments,
        state: row.State,
        testedBy: row.InspectorName,
        force: true,
      }
      try {
        const resp = await fetch(`${remoteUrl}/api/sync/update`, {
          method: 'POST',
          headers,
          body: JSON.stringify([update]),
          signal: AbortSignal.timeout(20_000),
        })
        const data = await resp.json().catch(() => ({} as { updatedCount?: number; rejected?: unknown[] }))
        const ok = resp.ok && (data.updatedCount ?? 0) > 0

        auditLog({
          type: 'sync.push.force',
          ioId: row.IoId,
          subsystemId: subsystemId ?? undefined,
          result: row.TestResult,
          version: Number(row.Version) || 0,
          user: row.InspectorName,
          reason: ok ? 'operator force-overwrite accepted by cloud' : `force push failed (http ${resp.status})`,
          detail: { pendingId: row.id, updatedCount: data.updatedCount ?? 0, rejected: data.rejected ?? [] },
        })

        if (ok) {
          db.prepare('DELETE FROM PendingSyncs WHERE id = ?').run(row.id)
          forced++
          results.push({ ioId: row.IoId, ok: true })
        } else {
          failed++
          results.push({ ioId: row.IoId, ok: false, error: `http ${resp.status}, updatedCount ${data.updatedCount ?? 0}` })
        }
      } catch (e) {
        failed++
        const msg = e instanceof Error ? e.message : String(e)
        auditLog({ type: 'sync.push.force', ioId: row.IoId, result: row.TestResult, user: row.InspectorName, reason: `force push error: ${msg}`, detail: { pendingId: row.id } })
        results.push({ ioId: row.IoId, ok: false, error: msg })
      }
    }

    return res.json({ success: true, forced, failed, total: rows.length, results })
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Force push failed' })
  }
}
