import { Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { getBackupDbPath } from '@/lib/db/backup'

export async function POST(req: Request, res: Response) {
  let backupPrisma: PrismaClient | null = null

  try {
    const filename = req.params.filename as string
    const body = req.body
    const { remoteUrl, apiPassword, subsystemId } = body

    if (!remoteUrl) {
      return res.status(400).json({ success: false, error: 'remoteUrl is required' })
    }

    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' })
    }

    const backupsDir = getBackupDbPath()
    const backupPath = path.join(backupsDir, filename)

    const resolved = path.resolve(backupPath)
    if (!resolved.startsWith(path.resolve(backupsDir))) {
      return res.status(400).json({ success: false, error: 'Invalid filename' })
    }

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: 'Backup not found' })
    }

    backupPrisma = new PrismaClient({ datasourceUrl: `file:${resolved}` })

    const pendingSyncs = await backupPrisma.pendingSync.findMany()
    console.log(`[BackupSync] Found ${pendingSyncs.length} pending syncs in backup`)

    const testHistories = await backupPrisma.testHistory.findMany({
      include: { io: { select: { id: true, name: true, subsystemId: true } } },
    })
    console.log(`[BackupSync] Found ${testHistories.length} test histories in backup`)

    let syncedPending = 0, syncedHistories = 0
    const errors: string[] = []

    if (pendingSyncs.length > 0) {
      try {
        const updates = pendingSyncs.map(ps => ({
          id: ps.ioId, testedBy: ps.inspectorName, result: ps.testResult, comments: ps.comments,
          state: ps.state, version: Number(ps.version), timestamp: ps.timestamp?.toISOString(),
        }))

        const response = await fetch(`${remoteUrl}/api/sync/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
          body: JSON.stringify({ updates }),
        })

        if (response.ok) {
          syncedPending = pendingSyncs.length
        } else {
          const errText = await response.text()
          errors.push(`Pending sync failed (${response.status}): ${errText}`)
        }
      } catch (error) {
        errors.push(`Pending sync error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (testHistories.length > 0 && subsystemId) {
      try {
        const histories = testHistories.map(th => ({
          ioId: th.ioId, result: th.result, timestamp: th.timestamp, comments: th.comments,
          testedBy: th.testedBy, state: th.state, failureMode: th.failureMode,
        }))

        const response = await fetch(`${remoteUrl}/api/sync/test-histories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
          body: JSON.stringify({ subsystemId, histories }),
        })

        if (response.ok) {
          syncedHistories = testHistories.length
        } else if (response.status === 404) {
          errors.push('Cloud server does not support test history sync endpoint')
        } else {
          const errText = await response.text()
          errors.push(`History sync failed (${response.status}): ${errText}`)
        }
      } catch (error) {
        errors.push(`History sync error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return res.json({
      success: errors.length === 0, syncedPending, syncedHistories,
      totalPending: pendingSyncs.length, totalHistories: testHistories.length,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[BackupSync] Error:', error)
    return res.status(500).json({ success: false, error: message })
  } finally {
    if (backupPrisma) { await backupPrisma.$disconnect().catch(() => {}) }
  }
}
