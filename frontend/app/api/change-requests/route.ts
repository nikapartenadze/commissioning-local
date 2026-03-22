export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { configService } from '@/lib/config'

// GET — list change requests with optional filters
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const ioId = searchParams.get('ioId')

    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (ioId) where.ioId = parseInt(ioId, 10)

    const requests = await prisma.changeRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ success: true, requests, count: requests.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

// POST — create a new change request
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { ioId, requestType, currentValue, requestedValue, structuredChanges, reason, requestedBy } = body

    if (!requestType || !reason || !requestedBy) {
      return NextResponse.json(
        { success: false, error: 'requestType, reason, and requestedBy are required' },
        { status: 400 }
      )
    }

    if (!['add', 'modify', 'remove'].includes(requestType)) {
      return NextResponse.json(
        { success: false, error: 'requestType must be add, modify, or remove' },
        { status: 400 }
      )
    }

    const changeRequest = await prisma.changeRequest.create({
      data: {
        ioId: ioId ? parseInt(String(ioId), 10) : null,
        requestType,
        currentValue: currentValue || null,
        requestedValue: requestedValue || null,
        structuredChanges: structuredChanges ? JSON.stringify(structuredChanges) : null,
        reason,
        requestedBy,
        status: 'pending',
      },
    })

    // Sync to cloud (non-blocking)
    const config = await configService.getConfig()
    if (config.remoteUrl && config.apiPassword) {
      try {
        const syncUrl = `${config.remoteUrl}/api/sync/change-requests`
        await fetch(syncUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': config.apiPassword,
          },
          body: JSON.stringify({
            requests: [{
              ioId: changeRequest.ioId,
              subsystemId: config.subsystemId ? parseInt(String(config.subsystemId), 10) : null,
              requestType: changeRequest.requestType,
              currentValue: changeRequest.currentValue,
              requestedValue: changeRequest.requestedValue,
              structuredChanges: changeRequest.structuredChanges,
              reason: changeRequest.reason,
              requestedBy: changeRequest.requestedBy,
              createdAt: changeRequest.createdAt,
            }],
          }),
          signal: AbortSignal.timeout(10000),
        })
        console.log('[ChangeRequest] Synced to cloud')
      } catch (err) {
        console.warn('[ChangeRequest] Cloud sync failed (saved locally):', err instanceof Error ? err.message : err)
      }
    }

    return NextResponse.json({ success: true, changeRequest })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
