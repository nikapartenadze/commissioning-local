export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

/**
 * GET /api/cloud/sync-pull
 *
 * Fetch IOs from cloud, compare versions, update changed ones locally.
 * Returns the full updated IO data for changed items so the browser
 * can merge directly without a second fetch.
 */
export async function GET() {
  try {
    const config = await configService.getConfig()
    const { remoteUrl, apiPassword, subsystemId } = config

    if (!remoteUrl || !subsystemId) {
      return NextResponse.json({ changed: [], connected: false })
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
        return NextResponse.json({ changed: [], connected: true })
      }
      if (!resp.ok) {
        return NextResponse.json({ changed: [], connected: false })
      }
      const data = await resp.json()
      cloudIos = data.ios || data.Ios || []
    } catch {
      return NextResponse.json({ changed: [], connected: false })
    }

    if (cloudIos.length === 0) {
      return NextResponse.json({ changed: [], connected: true })
    }

    // Compare with local and update changed IOs
    const changedIos: any[] = []

    const selectVersionStmt = db.prepare('SELECT Version FROM Ios WHERE id = ?')
    const updateIoStmt = db.prepare(`
      UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ?, Version = ?, Name = ?, Description = ?
      WHERE id = ?
    `)

    for (const cloudIo of cloudIos) {
      if (!cloudIo.id || cloudIo.id <= 0) continue

      const localIo = selectVersionStmt.get(cloudIo.id) as { Version: number } | undefined

      if (!localIo) continue

      const cloudVersion = Number(cloudIo.version) || 0
      const localVersion = localIo.Version ?? 0

      if (cloudVersion > localVersion) {
        updateIoStmt.run(
          cloudIo.result ?? null,
          cloudIo.timestamp ?? null,
          cloudIo.comments ?? null,
          cloudVersion,
          cloudIo.name,
          cloudIo.description ?? null,
          cloudIo.id,
        )

        // Return full IO data so browser can merge directly
        changedIos.push({
          id: cloudIo.id,
          name: cloudIo.name,
          description: cloudIo.description ?? null,
          result: cloudIo.result ?? null,
          timestamp: cloudIo.timestamp ?? null,
          comments: cloudIo.comments ?? null,
          version: cloudVersion.toString(),
        })
      }
    }

    if (changedIos.length > 0) {
      console.log(`[SyncPull] Updated ${changedIos.length} IOs from cloud`)
    }

    return NextResponse.json({ changed: changedIos, connected: true })
  } catch {
    return NextResponse.json({ changed: [], connected: false })
  }
}
