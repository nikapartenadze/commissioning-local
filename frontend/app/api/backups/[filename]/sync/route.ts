import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { getBackupDbPath } from '@/lib/db/backup'

interface RouteParams {
  params: Promise<{ filename: string }>
}

/**
 * POST /api/backups/[filename]/sync — Sync test data from a backup to cloud
 *
 * Opens the backup database, reads PendingSync and TestHistory records,
 * and pushes them to the cloud server.
 *
 * Body: { remoteUrl: string, apiPassword: string, subsystemId: number }
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  let backupPrisma: PrismaClient | null = null

  try {
    const { filename } = await params
    const body = await request.json()
    const { remoteUrl, apiPassword, subsystemId } = body

    if (!remoteUrl) {
      return NextResponse.json({ success: false, error: 'remoteUrl is required' }, { status: 400 })
    }

    // Validate filename
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 })
    }

    const backupsDir = getBackupDbPath()
    const backupPath = path.join(backupsDir, filename)

    const resolved = path.resolve(backupPath)
    if (!resolved.startsWith(path.resolve(backupsDir))) {
      return NextResponse.json({ success: false, error: 'Invalid filename' }, { status: 400 })
    }

    if (!fs.existsSync(backupPath)) {
      return NextResponse.json({ success: false, error: 'Backup not found' }, { status: 404 })
    }

    // Open backup database with a separate Prisma client
    backupPrisma = new PrismaClient({
      datasourceUrl: `file:${resolved}`,
    })

    // Read pending syncs from backup
    const pendingSyncs = await backupPrisma.pendingSync.findMany()
    console.log(`[BackupSync] Found ${pendingSyncs.length} pending syncs in backup`)

    // Read test histories from backup
    const testHistories = await backupPrisma.testHistory.findMany({
      include: { io: { select: { id: true, name: true, subsystemId: true } } },
    })
    console.log(`[BackupSync] Found ${testHistories.length} test histories in backup`)

    let syncedPending = 0
    let syncedHistories = 0
    const errors: string[] = []

    // Sync pending syncs to cloud as IO updates
    if (pendingSyncs.length > 0) {
      try {
        const updates = pendingSyncs.map(ps => ({
          id: ps.ioId,
          testedBy: ps.inspectorName,
          result: ps.testResult,
          comments: ps.comments,
          state: ps.state,
          version: Number(ps.version),
          timestamp: ps.timestamp?.toISOString(),
        }))

        const response = await fetch(`${remoteUrl}/api/sync/update`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiPassword || '',
          },
          body: JSON.stringify({ updates }),
        })

        if (response.ok) {
          syncedPending = pendingSyncs.length
          console.log(`[BackupSync] Synced ${syncedPending} pending updates to cloud`)
        } else {
          const errText = await response.text()
          errors.push(`Pending sync failed (${response.status}): ${errText}`)
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        errors.push(`Pending sync error: ${msg}`)
      }
    }

    // Sync test histories to cloud
    if (testHistories.length > 0 && subsystemId) {
      try {
        const histories = testHistories.map(th => ({
          ioId: th.ioId,
          result: th.result,
          timestamp: th.timestamp,
          comments: th.comments,
          testedBy: th.testedBy,
          state: th.state,
          failureMode: th.failureMode,
        }))

        const response = await fetch(`${remoteUrl}/api/sync/test-histories`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiPassword || '',
          },
          body: JSON.stringify({ subsystemId, histories }),
        })

        if (response.ok) {
          syncedHistories = testHistories.length
          console.log(`[BackupSync] Synced ${syncedHistories} test histories to cloud`)
        } else if (response.status === 404) {
          errors.push('Cloud server does not support test history sync endpoint')
        } else {
          const errText = await response.text()
          errors.push(`History sync failed (${response.status}): ${errText}`)
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        errors.push(`History sync error: ${msg}`)
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      syncedPending,
      syncedHistories,
      totalPending: pendingSyncs.length,
      totalHistories: testHistories.length,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[BackupSync] Error:', error)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  } finally {
    if (backupPrisma) {
      await backupPrisma.$disconnect().catch(() => {})
    }
  }
}
