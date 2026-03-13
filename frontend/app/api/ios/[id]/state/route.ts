import { NextRequest, NextResponse } from 'next/server'
import { getPlcClient, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { prisma } from '@/lib/db'

/**
 * GET /api/ios/[id]/state
 * Get the current PLC state for an IO and broadcast to sync all clients
 */
export async function GET(
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

    // Get the IO from database
    const io = await prisma.io.findUnique({
      where: { id: ioId },
      select: { id: true, name: true, tagType: true }
    })

    if (!io || !io.name) {
      return NextResponse.json(
        { success: false, error: 'IO not found' },
        { status: 404 }
      )
    }

    // Get PLC client and read current state
    const client = getPlcClient()

    if (!client.isConnected) {
      return NextResponse.json(
        { success: false, error: 'PLC not connected' },
        { status: 503 }
      )
    }

    // Read current tag value (per-tag handle, multi-user safe)
    const readResult = client.readOutputBit({
      id: io.id,
      name: io.name,
      tagType: io.tagType ?? undefined
    })

    if (!readResult.success) {
      return NextResponse.json(
        { success: false, error: readResult.error || 'Failed to read tag' },
        { status: 500 }
      )
    }

    const state = readResult.currentState

    // Broadcast the state to all WebSocket clients to sync UIs
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateState',
          id: ioId,
          state: state
        })
      })
    } catch {
      // WebSocket server might not be running
    }

    return NextResponse.json({
      success: true,
      ioId,
      state,
      stateString: state ? 'TRUE' : 'FALSE'
    })
  } catch (error) {
    console.error('[IO State] Error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to read state' },
      { status: 500 }
    )
  }
}
