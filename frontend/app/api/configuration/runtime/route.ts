import { Request, Response } from 'express'
import { configService } from '@/lib/config'
import { db } from '@/lib/db-sqlite'

const getSubsystemName = db.prepare('SELECT Name FROM Subsystems WHERE id = ?')

export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()

    // Resolve subsystem id → name so callers (FV view, belt-tracking,
    // etc.) can default-filter without a separate query.
    let subsystemName = ''
    const idNum = config.subsystemId ? parseInt(String(config.subsystemId), 10) : NaN
    if (!isNaN(idNum)) {
      const row = getSubsystemName.get(idNum) as { Name: string } | undefined
      subsystemName = row?.Name || ''
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
      subsystemName: '',
      ip: '',
      path: '1,0',
      remoteUrl: '',
      orderMode: '0',
      isConfigured: false,
    })
  }
}
