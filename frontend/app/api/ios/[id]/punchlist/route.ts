import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'
import { auditLog } from '@/lib/logging/recovery-log'

const VALID_STATUS = [null, 'ADDRESSED', 'CLARIFICATION']
const VALID_TRADE = [null, 'electrical', 'controls', 'mechanical']

export async function PATCH(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string)
    if (isNaN(ioId)) return res.status(400).json({ error: 'Invalid ID' })

    const body = req.body
    const { punchlistStatus, trade, clarificationNote } = body
    const updatedBy = body.updatedBy ?? body.currentUser ?? null

    if (punchlistStatus !== undefined && !VALID_STATUS.includes(punchlistStatus)) {
      return res.status(400).json({ error: 'Invalid punchlistStatus' })
    }
    if (trade !== undefined && !VALID_TRADE.includes(trade)) {
      return res.status(400).json({ error: 'Invalid trade' })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined
    if (!io) return res.status(404).json({ error: 'IO not found' })

    const setClauses: string[] = []
    const values: unknown[] = []

    if (punchlistStatus !== undefined) {
      setClauses.push('PunchlistStatus = ?')
      values.push(punchlistStatus)
    }
    if (trade !== undefined) {
      setClauses.push('Trade = ?')
      values.push(trade)
    }
    if (clarificationNote !== undefined) {
      setClauses.push('ClarificationNote = ?')
      values.push(clarificationNote)
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    // Bump the version like every other synced write — the cloud's monotonic
    // gate orders this against concurrent pushes from other laptops.
    const newVersion = (io.Version ?? 0) + 1
    setClauses.push('Version = ?')
    values.push(newVersion)
    values.push(ioId)
    db.prepare(`UPDATE Ios SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)

    // Durable recovery trail (2026-07-08 forensics audit): punchlist triage
    // previously wrote NO journal entry, so "who addressed what when" could
    // not be reconstructed. Old → new triple, kept small. auditLog never throws.
    auditLog({
      type: 'io.addressed',
      subsystemId: io.SubsystemId,
      ioId,
      user: updatedBy,
      version: newVersion,
      detail: {
        via: 'punchlist',
        before: { punchlistStatus: io.PunchlistStatus ?? null, trade: io.Trade ?? null, clarificationNote: io.ClarificationNote ?? null },
        after: {
          punchlistStatus: punchlistStatus !== undefined ? punchlistStatus : (io.PunchlistStatus ?? null),
          trade: trade !== undefined ? trade : (io.Trade ?? null),
          clarificationNote: clarificationNote !== undefined ? clarificationNote : (io.ClarificationNote ?? null),
        },
      },
    })

    // F4 (2026-07-03 sync audit): punchlist fields used to be LOCAL-ONLY —
    // lost on laptop replacement. They now ride the durable PendingSyncs
    // queue as a 'Punchlist Updated' metadata op (same shape as
    // 'Dependencies Updated'): no result change, no TestHistory row on
    // cloud, survives offline periods + restarts, retried by the 10s loop.
    // The queue row snapshots the CURRENT post-update triple so a null is an
    // explicit clear.
    try {
      const after = db.prepare('SELECT PunchlistStatus, Trade, ClarificationNote FROM Ios WHERE id = ?').get(ioId) as
        { PunchlistStatus: string | null; Trade: string | null; ClarificationNote: string | null }
      const info = db.prepare(
        `INSERT INTO PendingSyncs
           (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version, PunchlistStatus, Trade, ClarificationNote)
         VALUES (?, ?, 'Punchlist Updated', ?, NULL, ?, ?, ?, ?, ?)`
      ).run(
        ioId,
        updatedBy,
        io.Comments || null,
        new Date().toISOString(),
        newVersion - 1,
        after.PunchlistStatus,
        after.Trade,
        after.ClarificationNote,
      )
      console.log(
        `[Punchlist] PENDING-QUEUED pendingId=${info.lastInsertRowid} ioId=${ioId} ` +
        `status=${JSON.stringify(after.PunchlistStatus)} trade=${JSON.stringify(after.Trade)} user=${updatedBy ?? 'unknown'}`,
      )

      enqueueSyncPush(`io:${ioId}`, async () => {
        try {
          await drainPendingSyncsForIo(ioId, 'Punchlist', updatedBy)
        } catch (syncErr) {
          console.warn(`[Punchlist] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
        }
      })
    } catch (syncError) {
      // SQLite write already committed above — log loudly so the row isn't
      // silently stuck local-only.
      console.error(
        `[Punchlist] PENDING-QUEUE-FAIL ioId=${ioId} ` +
        `err=${syncError instanceof Error ? syncError.message : String(syncError)}`,
      )
    }

    const updated = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    return res.json({
      success: true,
      io: {
        id: updated.id,
        subsystemId: updated.SubsystemId,
        name: updated.Name,
        description: updated.Description,
        result: updated.Result,
        timestamp: updated.Timestamp,
        comments: updated.Comments,
        order: updated.Order,
        version: (updated.Version ?? 0).toString(),
        tagType: updated.TagType,
        networkDeviceName: updated.NetworkDeviceName,
        assignedTo: updated.AssignedTo,
        punchlistStatus: updated.PunchlistStatus,
        trade: updated.Trade,
        clarificationNote: updated.ClarificationNote,
      }
    })
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update punchlist' })
  }
}
