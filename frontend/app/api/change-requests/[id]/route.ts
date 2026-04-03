export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

interface RouteParams {
  params: Promise<{ id: string }>
}

interface ChangeRequestRow {
  id: number;
  IoId: number | null;
  RequestType: string;
  CurrentValue: string | null;
  RequestedValue: string | null;
  StructuredChanges: string | null;
  Reason: string;
  RequestedBy: string;
  Status: string;
  ReviewedBy: string | null;
  ReviewNote: string | null;
  CreatedAt: string | null;
  UpdatedAt: string | null;
}

function mapRow(r: ChangeRequestRow) {
  return {
    id: r.id,
    ioId: r.IoId,
    requestType: r.RequestType,
    currentValue: r.CurrentValue,
    requestedValue: r.RequestedValue,
    structuredChanges: r.StructuredChanges,
    reason: r.Reason,
    requestedBy: r.RequestedBy,
    status: r.Status,
    reviewedBy: r.ReviewedBy,
    reviewNote: r.ReviewNote,
    createdAt: r.CreatedAt,
    updatedAt: r.UpdatedAt,
  }
}

// PUT — update change request status
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params
    const numId = parseInt(id, 10)
    if (isNaN(numId)) {
      return NextResponse.json({ success: false, error: 'Invalid ID' }, { status: 400 })
    }

    const body = await request.json()
    const { status, reviewedBy, reviewNote } = body

    if (!status || !['pending', 'approved', 'rejected', 'synced'].includes(status)) {
      return NextResponse.json(
        { success: false, error: 'Valid status required (pending/approved/rejected/synced)' },
        { status: 400 }
      )
    }

    // Build dynamic SET clause
    const sets: string[] = ['Status = ?']
    const params2: unknown[] = [status]

    if (reviewedBy) {
      sets.push('ReviewedBy = ?')
      params2.push(reviewedBy)
    }
    if (reviewNote) {
      sets.push('ReviewNote = ?')
      params2.push(reviewNote)
    }
    sets.push('UpdatedAt = ?')
    params2.push(new Date().toISOString())

    params2.push(numId)

    const result = db.prepare(
      `UPDATE ChangeRequests SET ${sets.join(', ')} WHERE id = ?`
    ).run(...params2)

    if (result.changes === 0) {
      return NextResponse.json({ success: false, error: 'Change request not found' }, { status: 404 })
    }

    const updated = db.prepare('SELECT * FROM ChangeRequests WHERE id = ?').get(numId) as ChangeRequestRow

    return NextResponse.json({ success: true, changeRequest: mapRow(updated) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const statusCode = message.includes('not found') ? 404 : 500
    return NextResponse.json({ success: false, error: message }, { status: statusCode })
  }
}

// DELETE — cancel a pending change request
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params
    const numId = parseInt(id, 10)
    if (isNaN(numId)) {
      return NextResponse.json({ success: false, error: 'Invalid ID' }, { status: 400 })
    }

    const existing = db.prepare('SELECT id, Status FROM ChangeRequests WHERE id = ?').get(numId) as { id: number; Status: string } | undefined
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    if (existing.Status !== 'pending') {
      return NextResponse.json(
        { success: false, error: 'Only pending requests can be cancelled' },
        { status: 400 }
      )
    }

    db.prepare('DELETE FROM ChangeRequests WHERE id = ?').run(numId)
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
