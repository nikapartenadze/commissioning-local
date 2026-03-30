export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getPlcClient } from '@/lib/plc-client-manager'
import { requireAuth } from '@/lib/auth/middleware'

// Active bypass intervals — keyed by BSS tag name
const activeBypass = (globalThis as any).__activeBypass ??= new Map<string, NodeJS.Timeout>()

export async function POST(request: NextRequest) {
  const authError = requireAuth(request)
  if (authError) return authError

  try {
    const { bssTag, action } = await request.json()
    // action: 'start' | 'stop'

    if (!bssTag || typeof bssTag !== 'string') {
      return NextResponse.json({ success: false, error: 'bssTag is required' }, { status: 400 })
    }

    const client = getPlcClient()
    if (!client.isConnected) {
      return NextResponse.json({ success: false, error: 'PLC not connected' }, { status: 503 })
    }

    if (action === 'start') {
      // Stop any existing bypass on this tag
      if (activeBypass.has(bssTag)) {
        clearInterval(activeBypass.get(bssTag)!)
      }

      // Write true immediately
      const result = client.writeOutputBit({ id: -1, name: bssTag }, 1)
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 })
      }

      // Start continuous write every 500ms
      const interval = setInterval(() => {
        try {
          if (client.isConnected) {
            client.writeOutputBit({ id: -1, name: bssTag }, 1)
          } else {
            // PLC disconnected — stop bypass
            clearInterval(interval)
            activeBypass.delete(bssTag)
          }
        } catch {
          clearInterval(interval)
          activeBypass.delete(bssTag)
        }
      }, 500)

      activeBypass.set(bssTag, interval)

      console.log(`[SafetyBypass] STARTED bypass on ${bssTag}`)
      return NextResponse.json({ success: true, bssTag, active: true })
    }

    if (action === 'stop') {
      if (activeBypass.has(bssTag)) {
        clearInterval(activeBypass.get(bssTag)!)
        activeBypass.delete(bssTag)
      }

      // Write false to release
      try {
        client.writeOutputBit({ id: -1, name: bssTag }, 0)
      } catch { /* PLC may already be disconnected */ }

      console.log(`[SafetyBypass] STOPPED bypass on ${bssTag}`)
      return NextResponse.json({ success: true, bssTag, active: false })
    }

    return NextResponse.json({ success: false, error: 'action must be start or stop' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to control bypass' }, { status: 500 })
  }
}

// GET — check if any bypass is active
export async function GET() {
  const active = Array.from(activeBypass.keys())
  return NextResponse.json({ success: true, active })
}
