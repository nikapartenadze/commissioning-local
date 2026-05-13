import { Request, Response } from 'express'
import { configService } from '@/lib/config'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()

    // Resolve subsystem name from the configured subsystemId so the UI
    // (diagram page, header chips) doesn't have to double-fetch.
    let subsystemName: string | null = null
    if (config.subsystemId) {
      const id = typeof config.subsystemId === 'string'
        ? parseInt(config.subsystemId, 10)
        : config.subsystemId
      if (Number.isInteger(id) && id > 0) {
        try {
          const row = db.prepare('SELECT Name FROM Subsystems WHERE id = ?').get(id) as
            | { Name: string | null }
            | undefined
          subsystemName = row?.Name ?? null
        } catch { /* table may not exist on first boot */ }
      }
    }

    return res.json({
      subsystemId: config.subsystemId || '',
      subsystemName,
      ip: config.ip || '',
      path: config.path || '1,0',
      remoteUrl: config.remoteUrl || '',
      orderMode: config.orderMode || '0',
      isConfigured: configService.isConfigured(),
    })
  } catch (error) {
    console.error('Failed to load runtime config:', error)
    return res.json({
      subsystemId: '',
      subsystemName: null,
      ip: '',
      path: '1,0',
      remoteUrl: '',
      orderMode: '0',
      isConfigured: false,
    })
  }
}
