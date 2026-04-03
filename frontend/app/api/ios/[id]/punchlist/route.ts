export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { requireAuth } from '@/lib/auth/middleware'

const VALID_STATUS = [null, 'ADDRESSED', 'CLARIFICATION']
const VALID_TRADE = [null, 'electrical', 'controls', 'mechanical']

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request)
  if (authError) return authError

  try {
    const { id } = await params
    const ioId = parseInt(id)
    if (isNaN(ioId)) return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })

    const body = await request.json()
    const { punchlistStatus, trade, clarificationNote } = body

    if (punchlistStatus !== undefined && !VALID_STATUS.includes(punchlistStatus)) {
      return NextResponse.json({ error: 'Invalid punchlistStatus' }, { status: 400 })
    }
    if (trade !== undefined && !VALID_TRADE.includes(trade)) {
      return NextResponse.json({ error: 'Invalid trade' }, { status: 400 })
    }

    // Build dynamic SET clause
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
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    values.push(ioId)
    db.prepare(`UPDATE Ios SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)

    const updated = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    return NextResponse.json({
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
    return NextResponse.json({ error: 'Failed to update punchlist' }, { status: 500 })
  }
}
