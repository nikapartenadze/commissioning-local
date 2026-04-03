export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { getPlcClient, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { requireAuth } from '@/lib/auth/middleware'

/**
 * POST /api/ios/[id]/fire-output
 * Fire (turn ON) an output - used when user presses the button
 *
 * Body: { action: 'start' | 'stop' }
 * - 'start': Turn output ON (when user presses)
 * - 'stop': Turn output OFF (when user releases)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request)
  if (authError) return authError

  try {
    const { id } = await params
    const ioId = parseInt(id, 10)

    if (isNaN(ioId)) {
      return NextResponse.json(
        { success: false, error: 'Invalid IO ID' },
        { status: 400 }
      )
    }

    // Get action from body (default to 'start' for backward compatibility)
    let action: 'start' | 'stop' | 'toggle' = 'start'
    try {
      const body = await request.json()
      if (body.action === 'stop') {
        action = 'stop'
      } else if (body.action === 'toggle') {
        action = 'toggle'
      }
    } catch {
      // No body or invalid JSON - default to 'start'
    }

    console.log(`[FireOutput] IO ${ioId}: ${action}`)

    // Get the IO from database
    const io = db.prepare('SELECT id, Name, TagType FROM Ios WHERE id = ?').get(ioId) as Pick<Io, 'id' | 'Name' | 'TagType'> | undefined

    if (!io) {
      return NextResponse.json(
        { success: false, error: 'IO not found' },
        { status: 404 }
      )
    }

    if (!io.Name) {
      return NextResponse.json(
        { success: false, error: 'IO has no tag name' },
        { status: 400 }
      )
    }

    // Check if this is a safety output - these cannot be written directly
    if (io.Name.includes(':SO.')) {
      return NextResponse.json(
        { success: false, error: 'Safety outputs cannot be fired directly - they are controlled by the safety PLC' },
        { status: 400 }
      )
    }

    // Get PLC client and write to output
    const client = getPlcClient()

    if (!client.isConnected) {
      return NextResponse.json(
        { success: false, error: 'PLC not connected' },
        { status: 503 }
      )
    }

    // Determine target value
    const bitValue: number | 'toggle' = action === 'toggle' ? 'toggle' : (action === 'start' ? 1 : 0)

    // Atomic write — each tag gets its own handle, safe for concurrent multi-user use
    const result = client.writeOutputBit(
      { id: io.id, name: io.Name, tagType: io.TagType ?? undefined },
      bitValue
    )

    if (!result.success) {
      console.error(`[FireOutput] Failed to ${action} output:`, result.error)
      return NextResponse.json(
        { success: false, error: result.error || `Failed to ${action} output` },
        { status: 500 }
      )
    }

    // Compute the new state after write
    let newState: boolean
    if (action === 'toggle') {
      newState = !result.currentState
    } else {
      newState = action === 'start'
    }

    // Broadcast state change to WebSocket clients
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateState',
          id: ioId,
          state: newState
        })
      })
    } catch {
      // WebSocket server might not be running
    }

    console.log(`[FireOutput] IO ${ioId} ${newState ? 'ON' : 'OFF'}`)

    return NextResponse.json({
      success: true,
      action,
      ioId,
      state: newState,
      message: `Output ${newState ? 'ON' : 'OFF'}`
    })
  } catch (error) {
    console.error('[FireOutput] Error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to control output' },
      { status: 500 }
    )
  }
}
