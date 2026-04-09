import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const { remoteUrl, apiPassword, subsystemId } = config

    if (!remoteUrl || !subsystemId) {
      return res.json({ changed: [], connected: false })
    }

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
        return res.json({ changed: [], connected: true })
      }
      if (!resp.ok) {
        return res.json({ changed: [], connected: false })
      }
      const data = await resp.json()
      cloudIos = data.ios || data.Ios || []
    } catch {
      return res.json({ changed: [], connected: false })
    }

    if (cloudIos.length === 0) {
      return res.json({ changed: [], connected: true })
    }

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

    return res.json({ changed: changedIos, connected: true })
  } catch {
    return res.json({ changed: [], connected: false })
  }
}
