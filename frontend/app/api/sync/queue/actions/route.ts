import { Request, Response } from 'express'
import { retry, discard, selectRefs, type QueueKind, type Classification } from '@/lib/sync/queue-inspector'
import { createBackup } from '@/lib/db/backup'

const VALID_KINDS: QueueKind[] = ['io', 'l2', 'blocker']
const VALID_CLASSIFICATIONS: Classification[] = ['gone_on_cloud', 'version_conflict', 'transient', 'unknown']

/**
 * Sync Center actions — RETRY or DISCARD outbound queue rows.
 *
 * POST /api/sync/queue/actions
 *   body: {
 *     action: 'retry' | 'discard',
 *     ids?: { kind: 'io'|'l2'|'blocker', id: number }[],  // explicit selection
 *     classification?: Classification,                     // all parked of a kind
 *     allParked?: boolean                                  // all parked rows
 *   }
 *
 * DATA SAFETY: retry only clears the parked flag + resets retry/error on the
 * QUEUE row; discard only DELETEs the QUEUE row. Neither ever touches the
 * underlying value in Ios / L2CellValues / Devices.
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = (req.body || {}) as {
      action?: string
      ids?: { kind: QueueKind; id: number }[]
      classification?: Classification
      allParked?: boolean
    }

    const action = body.action
    if (action !== 'retry' && action !== 'discard') {
      return res.status(400).json({ error: "Invalid 'action' — expected 'retry' or 'discard'." })
    }

    // Validate the selector shape before doing anything.
    if (Array.isArray(body.ids)) {
      const bad = body.ids.some(
        (r) => !r || !VALID_KINDS.includes(r.kind) || !Number.isInteger(r.id),
      )
      if (bad) {
        return res.status(400).json({ error: "Invalid 'ids' — each ref needs { kind: 'io'|'l2'|'blocker', id: number }." })
      }
    }
    if (body.classification && !VALID_CLASSIFICATIONS.includes(body.classification)) {
      return res.status(400).json({ error: "Invalid 'classification'." })
    }

    const hasSelector =
      (Array.isArray(body.ids) && body.ids.length > 0) || !!body.classification || body.allParked === true
    if (!hasSelector) {
      return res.status(400).json({ error: 'No rows selected — provide ids, classification, or allParked.' })
    }

    const refs = selectRefs({ ids: body.ids, classification: body.classification, allParked: body.allParked })

    if (action === 'retry') {
      const { affected } = retry(refs)
      return res.json({ action, affected, message: `Re-queued ${affected} row(s) for sync.` })
    }

    // Safety net: a BULK discard (allParked / by-classification — a mass delete)
    // takes a full DB snapshot first, so a mis-click is recoverable. A single
    // explicit-`ids` discard is NOT backed up: it removes one outbound queue row
    // and is non-destructive to the underlying data value, so a heavy full-DB
    // snapshot per row would be pure overhead. mirrors selectRefs' precedence:
    // when ids are provided they win, so that path is never "bulk".
    const explicitIds = Array.isArray(body.ids) && body.ids.length > 0
    const isBulkDiscard = !explicitIds && (body.allParked === true || !!body.classification)
    let backupFilename: string | undefined
    if (isBulkDiscard) {
      try {
        const backup = await createBackup('before-sync-queue-clear')
        backupFilename = backup.filename
      } catch (backupErr) {
        // Never block the user on a backup failure — log and proceed.
        console.warn('[SyncCenter] pre-bulk-discard backup failed (proceeding anyway):', backupErr)
      }
    }

    const { affected } = discard(refs)
    return res.json({
      action,
      affected,
      ...(backupFilename ? { backup: backupFilename } : {}),
      message: `Discarded ${affected} stuck queue row(s). Your local data was NOT changed — only the pending-to-cloud copy was removed.`,
    })
  } catch (error) {
    console.error('Failed to run sync queue action:', error)
    return res.status(500).json({ error: 'Failed to run sync queue action' })
  }
}
