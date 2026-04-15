import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

const stmts = {
  getBySubsystem: db.prepare('SELECT * FROM VfdCheckState WHERE subsystemId = ?'),
  getExisting: db.prepare('SELECT id FROM VfdCheckState WHERE deviceName = ? AND subsystemId = ?'),
  getRow: db.prepare('SELECT * FROM VfdCheckState WHERE deviceName = ? AND subsystemId = ?'),
}

/**
 * GET /api/vfd-commissioning/state?subsystemId=N
 *
 * Returns saved VFD check states for a subsystem.
 */
export async function GET(req: Request, res: Response) {
  try {
    const subsystemId = parseInt(req.query.subsystemId as string)
    if (!subsystemId || isNaN(subsystemId)) {
      return res.status(400).json({ error: 'subsystemId required' })
    }

    const states = stmts.getBySubsystem.all(subsystemId)
    return res.json({ states })
  } catch (error) {
    console.error('[VFD State GET] Error:', error)
    return res.status(500).json({ error: 'Failed to fetch VFD check states' })
  }
}

/**
 * POST /api/vfd-commissioning/state
 *
 * Upsert a VFD check state row. Supports updating individual check statuses,
 * check3 comment, speed_fpm, and last_rpm.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, subsystemId, check, status, comment, speedFpm, lastRpm, updatedBy } = req.body
    if (!deviceName || !subsystemId) {
      return res.status(400).json({ error: 'deviceName and subsystemId required' })
    }

    const now = new Date().toISOString()
    const existing = stmts.getExisting.get(deviceName, subsystemId) as { id: number } | undefined

    if (existing) {
      // Build dynamic UPDATE
      const updates: string[] = ['updatedAt = ?', 'updatedBy = ?']
      const params: any[] = [now, updatedBy || null]

      if (check !== undefined && status !== undefined) {
        const checkNum = parseInt(check)
        if (checkNum >= 1 && checkNum <= 5) {
          updates.push(`check${checkNum}_status = ?`)
          params.push(status)
        }
      }
      if (check === 3 && comment !== undefined) {
        updates.push('check3_comment = ?')
        params.push(comment)
      }
      if (speedFpm !== undefined) {
        updates.push('speed_fpm = ?')
        params.push(speedFpm)
      }
      if (lastRpm !== undefined) {
        updates.push('last_rpm = ?')
        params.push(lastRpm)
      }

      params.push(deviceName, subsystemId)
      db.prepare(`UPDATE VfdCheckState SET ${updates.join(', ')} WHERE deviceName = ? AND subsystemId = ?`).run(...params)
    } else {
      // INSERT new row with all columns, filling in only the provided values
      const checkNum = check !== undefined ? parseInt(check) : null
      db.prepare(`
        INSERT INTO VfdCheckState (
          deviceName, subsystemId,
          check1_status, check2_status, check3_status, check3_comment,
          check4_status, check5_status,
          speed_fpm, last_rpm,
          updatedBy, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceName,
        subsystemId,
        checkNum === 1 ? status : null,
        checkNum === 2 ? status : null,
        checkNum === 3 ? status : null,
        checkNum === 3 && comment !== undefined ? comment : null,
        checkNum === 4 ? status : null,
        checkNum === 5 ? status : null,
        speedFpm !== undefined ? speedFpm : null,
        lastRpm !== undefined ? lastRpm : null,
        updatedBy || null,
        now,
      )
    }

    return res.json({ success: true })
  } catch (error) {
    console.error('[VFD State POST] Error:', error)
    return res.status(500).json({ error: 'Failed to save VFD check state' })
  }
}
