import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'

const VALID_STATUS = [null, 'ADDRESSED', 'CLARIFICATION']
const VALID_TRADE = [null, 'electrical', 'controls', 'mechanical']

export async function PATCH(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string)
    if (isNaN(ioId)) return res.status(400).json({ error: 'Invalid ID' })

    const body = req.body
    const { punchlistStatus, trade, clarificationNote } = body

    if (punchlistStatus !== undefined && !VALID_STATUS.includes(punchlistStatus)) {
      return res.status(400).json({ error: 'Invalid punchlistStatus' })
    }
    if (trade !== undefined && !VALID_TRADE.includes(trade)) {
      return res.status(400).json({ error: 'Invalid trade' })
    }

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

    values.push(ioId)
    db.prepare(`UPDATE Ios SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)

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
