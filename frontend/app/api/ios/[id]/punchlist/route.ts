export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
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

    const data: any = {}
    if (punchlistStatus !== undefined) data.punchlistStatus = punchlistStatus
    if (trade !== undefined) data.trade = trade
    if (clarificationNote !== undefined) data.clarificationNote = clarificationNote

    const updated = await prisma.io.update({
      where: { id: ioId },
      data,
    })

    return NextResponse.json({ success: true, io: { ...updated, version: updated.version.toString() } })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update punchlist' }, { status: 500 })
  }
}
