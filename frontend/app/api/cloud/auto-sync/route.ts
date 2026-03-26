/**
 * Auto-Sync API Route
 *
 * POST   - Start auto-sync
 * DELETE - Stop auto-sync
 * GET    - Get auto-sync status
 */

import { NextRequest, NextResponse } from 'next/server'
import { startAutoSync, stopAutoSync, getAutoSyncService } from '@/lib/cloud/auto-sync'
import type { AutoSyncConfig } from '@/lib/cloud/auto-sync'

// POST /api/cloud/auto-sync — start auto-sync
export async function POST(request: NextRequest) {
  try {
    let config: Partial<AutoSyncConfig> = {}

    // Allow optional config override in request body
    try {
      const body = await request.json()
      if (body.pushIntervalMs) config.pushIntervalMs = body.pushIntervalMs
      if (body.enabled !== undefined) config.enabled = body.enabled
      if (body.maxRetries) config.maxRetries = body.maxRetries
    } catch {
      // No body or invalid JSON — use defaults
    }

    const service = startAutoSync(config)
    const status = await service.getStatus()

    return NextResponse.json({ success: true, message: 'Auto-sync started', status })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// DELETE /api/cloud/auto-sync — stop auto-sync
export async function DELETE() {
  try {
    stopAutoSync()
    return NextResponse.json({ success: true, message: 'Auto-sync stopped' })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// GET /api/cloud/auto-sync — get status
export async function GET() {
  try {
    const service = getAutoSyncService()
    if (!service) {
      return NextResponse.json({
        running: false,
        config: null,
        lastPushAt: null,
        lastPullAt: null,
        lastPushResult: null,
        lastPullResult: null,
        pendingCount: null,
      })
    }

    const status = await service.getStatus()
    return NextResponse.json(status)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
