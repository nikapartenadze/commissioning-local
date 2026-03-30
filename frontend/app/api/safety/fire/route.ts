export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getPlcClient } from '@/lib/plc-client-manager'
import { requireAuth } from '@/lib/auth/middleware'

export async function POST(request: NextRequest) {
  const authError = requireAuth(request)
  if (authError) return authError

  try {
    const { tag, action } = await request.json()
    // action: 'start' | 'stop' | 'toggle'

    if (!tag || typeof tag !== 'string') {
      return NextResponse.json({ success: false, error: 'tag is required' }, { status: 400 })
    }

    // Only allow STD_ prefixed tags
    if (!tag.startsWith('STD_')) {
      return NextResponse.json({ success: false, error: 'Only STD_ intermediary tags can be fired' }, { status: 400 })
    }

    const client = getPlcClient()
    if (!client.isConnected) {
      return NextResponse.json({ success: false, error: 'PLC not connected' }, { status: 503 })
    }

    const bitValue: number | 'toggle' = action === 'toggle' ? 'toggle' : (action === 'stop' ? 0 : 1)
    const result = client.writeOutputBit({ id: -1, name: tag }, bitValue)

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    }

    const newState = action === 'toggle' ? !result.currentState : action !== 'stop'
    return NextResponse.json({ success: true, tag, state: newState })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fire safety output' }, { status: 500 })
  }
}
