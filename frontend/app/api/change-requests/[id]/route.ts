export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

interface RouteParams {
  params: Promise<{ id: string }>
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

    const updated = await prisma.changeRequest.update({
      where: { id: numId },
      data: {
        status,
        reviewedBy: reviewedBy || undefined,
        reviewNote: reviewNote || undefined,
        updatedAt: new Date(),
      },
    })

    return NextResponse.json({ success: true, changeRequest: updated })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('not found') ? 404 : 500
    return NextResponse.json({ success: false, error: message }, { status })
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

    const existing = await prisma.changeRequest.findUnique({ where: { id: numId } })
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    if (existing.status !== 'pending') {
      return NextResponse.json(
        { success: false, error: 'Only pending requests can be cancelled' },
        { status: 400 }
      )
    }

    await prisma.changeRequest.delete({ where: { id: numId } })
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
