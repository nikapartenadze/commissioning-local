import { NextRequest, NextResponse } from 'next/server'
import { getPlcClient, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { prisma } from '@/lib/db'

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
    const io = await prisma.io.findUnique({
      where: { id: ioId },
      select: { id: true, name: true, tagType: true }
    })

    if (!io) {
      return NextResponse.json(
        { success: false, error: 'IO not found' },
        { status: 404 }
      )
    }

    if (!io.name) {
      return NextResponse.json(
        { success: false, error: 'IO has no tag name' },
        { status: 400 }
      )
    }

    // Check if this is a safety output - these cannot be written directly
    if (io.name.includes(':SO.')) {
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

    // Initialize output tag if needed
    // Convert null to undefined for optional fields to match IoTag interface
    const initResult = client.initializeOutputTag({
      id: io.id,
      name: io.name,
      tagType: io.tagType ?? undefined
    })
    if (!initResult.success) {
      return NextResponse.json(
        { success: false, error: 'Failed to initialize output tag' },
        { status: 500 }
      )
    }

    // Broadcast the actual current state to sync UI before any write
    // This fixes the "click twice" issue where UI shows stale state
    console.log(`[FireOutput] IO ${ioId} current PLC state: ${initResult.currentState}`)
    if (initResult.currentState !== undefined) {
      try {
        await fetch(getWsBroadcastUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'UpdateState',
            id: ioId,
            state: initResult.currentState
          })
        })
      } catch {
        // WebSocket server might not be running
      }
    }

    // Determine the target value based on action
    let value: number
    let newState: boolean
    if (action === 'toggle') {
      // Toggle: opposite of current state
      value = initResult.currentState ? 0 : 1
      newState = !initResult.currentState
    } else {
      // Start/Stop: explicit value
      value = action === 'start' ? 1 : 0
      newState = action === 'start'
    }

    const result = await client.setBit(value)

    if (!result.success) {
      console.error(`[FireOutput] Failed to ${action} output:`, result.error)
      return NextResponse.json(
        { success: false, error: result.error || `Failed to ${action} output` },
        { status: 500 }
      )
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
