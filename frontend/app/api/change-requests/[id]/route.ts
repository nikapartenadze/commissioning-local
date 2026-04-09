import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

interface ChangeRequestRow { id: number; IoId: number | null; RequestType: string; CurrentValue: string | null; RequestedValue: string | null; StructuredChanges: string | null; Reason: string; RequestedBy: string; Status: string; ReviewedBy: string | null; ReviewNote: string | null; CreatedAt: string | null; UpdatedAt: string | null; }

function mapRow(r: ChangeRequestRow) {
  return { id: r.id, ioId: r.IoId, requestType: r.RequestType, currentValue: r.CurrentValue, requestedValue: r.RequestedValue, structuredChanges: r.StructuredChanges, reason: r.Reason, requestedBy: r.RequestedBy, status: r.Status, reviewedBy: r.ReviewedBy, reviewNote: r.ReviewNote, createdAt: r.CreatedAt, updatedAt: r.UpdatedAt }
}

export async function PUT(req: Request, res: Response) {
  try {
    const numId = parseInt(req.params.id as string, 10)
    if (isNaN(numId)) return res.status(400).json({ success: false, error: 'Invalid ID' })

    const body = req.body
    const { status, reviewedBy, reviewNote } = body

    if (!status || !['pending', 'approved', 'rejected', 'synced'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Valid status required (pending/approved/rejected/synced)' })
    }

    const sets: string[] = ['Status = ?'], params2: unknown[] = [status]
    if (reviewedBy) { sets.push('ReviewedBy = ?'); params2.push(reviewedBy) }
    if (reviewNote) { sets.push('ReviewNote = ?'); params2.push(reviewNote) }
    sets.push('UpdatedAt = ?'); params2.push(new Date().toISOString())
    params2.push(numId)

    const result = db.prepare(`UPDATE ChangeRequests SET ${sets.join(', ')} WHERE id = ?`).run(...params2)
    if (result.changes === 0) return res.status(404).json({ success: false, error: 'Change request not found' })

    const updated = db.prepare('SELECT * FROM ChangeRequests WHERE id = ?').get(numId) as ChangeRequestRow
    return res.json({ success: true, changeRequest: mapRow(updated) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(message.includes('not found') ? 404 : 500).json({ success: false, error: message })
  }
}

export async function DELETE(req: Request, res: Response) {
  try {
    const numId = parseInt(req.params.id as string, 10)
    if (isNaN(numId)) return res.status(400).json({ success: false, error: 'Invalid ID' })

    const existing = db.prepare('SELECT id, Status FROM ChangeRequests WHERE id = ?').get(numId) as { id: number; Status: string } | undefined
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' })
    if (existing.Status !== 'pending') return res.status(400).json({ success: false, error: 'Only pending requests can be cancelled' })

    db.prepare('DELETE FROM ChangeRequests WHERE id = ?').run(numId)
    return res.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
