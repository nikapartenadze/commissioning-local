import { Request, Response } from 'express'
import { db, ioToApi } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'

/**
 * PATCH /api/ios/:id/dependencies
 *
 * Toggles the per-IO `hasDependencies` flag (the "Dependencies" Yes/No
 * column in the grid). Persists locally and queues a sync to cloud so
 * coordinators see the same value on the dashboard. Mirrors the punchlist
 * route's shape, but this field IS synced to cloud (sidebar filter relies
 * on it).
 *
 * Body: { hasDependencies: boolean, currentUser?: string }
 */
export async function PATCH(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string)
    if (isNaN(ioId)) return res.status(400).json({ error: 'Invalid IO ID' })

    const { hasDependencies, currentUser } = req.body ?? {}
    if (typeof hasDependencies !== 'boolean') {
      return res.status(400).json({ error: 'hasDependencies must be a boolean' })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined
    if (!io) return res.status(404).json({ error: 'IO not found' })

    const flag = hasDependencies ? 1 : 0
    if (io.HasDependencies === flag) {
      // No-op — return current state without bumping version or queueing sync.
      const refreshed = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io
      return res.json({ success: true, io: ioToApi(refreshed) })
    }

    const newVersion = (io.Version ?? 0) + 1
    db.prepare('UPDATE Ios SET HasDependencies = ?, Version = ? WHERE id = ?')
      .run(flag, newVersion, ioId)

    // Piggyback on the existing PendingSync queue so this rides the same
    // retry / drain path as test results. We map it to a dedicated op
    // string the cloud receiver recognises and treats as a metadata-only
    // update (no result change, no TestHistory row).
    try {
      const info = db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version, HasDependencies) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        'Dependencies Updated',
        io.Comments || null,
        null,
        new Date().toISOString(),
        newVersion - 1,
        flag,
      )
      console.log(
        `[Dependencies] PENDING-QUEUED pendingId=${info.lastInsertRowid} ioId=${ioId} ` +
        `hasDependencies=${hasDependencies} tester=${currentUser ?? 'unknown'}`,
      )

      const key = `io:${ioId}`
      enqueueSyncPush(key, async () => {
        try {
          await drainPendingSyncsForIo(ioId, 'Dependencies', currentUser)
        } catch (syncErr) {
          console.warn(`[Dependencies] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
        }
      })
    } catch (syncError) {
      // SQLite write already committed above — log loudly so the row isn't
      // silently stuck local-only.
      console.error(
        `[Dependencies] PENDING-QUEUE-FAIL ioId=${ioId} hasDependencies=${hasDependencies} ` +
        `err=${syncError instanceof Error ? syncError.message : String(syncError)}`,
      )
    }

    const updated = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io
    return res.json({ success: true, io: ioToApi(updated) })
  } catch (error) {
    console.error('Error updating dependencies:', error)
    return res.status(500).json({ error: 'Failed to update dependencies' })
  }
}
