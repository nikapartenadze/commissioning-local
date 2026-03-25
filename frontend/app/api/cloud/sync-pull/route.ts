export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { configService } from '@/lib/config'

/**
 * GET /api/cloud/sync-pull
 *
 * Simple endpoint: fetch IOs from cloud, compare versions, update changed ones.
 * Returns list of changed IO IDs so the browser knows what to refresh.
 * Called by the browser every 3 seconds.
 */
export async function GET() {
  try {
    const config = await configService.getConfig()
    const { remoteUrl, apiPassword, subsystemId } = config

    if (!remoteUrl || !subsystemId) {
      return NextResponse.json({ changed: [], connected: false, reason: 'not configured' })
    }

    // Fetch from cloud
    const cloudUrl = `${remoteUrl}/api/sync/subsystem/${subsystemId}`
    let cloudIos: any[]
    try {
      const resp = await fetch(cloudUrl, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiPassword || '',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (resp.status === 429) {
        return NextResponse.json({ changed: [], connected: true, reason: 'rate limited', backoff: true })
      }
      if (!resp.ok) {
        return NextResponse.json({ changed: [], connected: false, reason: `cloud ${resp.status}` })
      }
      const data = await resp.json()
      cloudIos = data.ios || data.Ios || []
    } catch {
      return NextResponse.json({ changed: [], connected: false, reason: 'unreachable' })
    }

    if (cloudIos.length === 0) {
      return NextResponse.json({ changed: [], connected: true })
    }

    // Compare with local and update changed IOs
    const changedIds: number[] = []

    for (const cloudIo of cloudIos) {
      if (!cloudIo.id || cloudIo.id <= 0) continue

      const localIo = await prisma.io.findUnique({
        where: { id: cloudIo.id },
        select: { version: true },
      })

      if (!localIo) continue

      const cloudVersion = BigInt(Number(cloudIo.version) || 0)
      const localVersion = localIo.version ?? BigInt(0)

      // Only update if cloud version is HIGHER (cloud has newer data)
      // Never overwrite local changes that haven't synced yet
      if (cloudVersion > localVersion) {
        await prisma.io.update({
          where: { id: cloudIo.id },
          data: {
            result: cloudIo.result ?? null,
            timestamp: cloudIo.timestamp ?? null,
            comments: cloudIo.comments ?? null,
            version: cloudVersion,
            name: cloudIo.name,
            description: cloudIo.description ?? null,
          },
        })
        changedIds.push(cloudIo.id)
      }
    }

    return NextResponse.json({ changed: changedIds, connected: true })
  } catch (error) {
    return NextResponse.json({ changed: [], connected: false, reason: 'error' })
  }
}
