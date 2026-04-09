import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

interface ChangeRequestRow { id: number; IoId: number | null; RequestType: string; CurrentValue: string | null; RequestedValue: string | null; StructuredChanges: string | null; Reason: string; RequestedBy: string; Status: string; ReviewedBy: string | null; ReviewNote: string | null; CreatedAt: string | null; UpdatedAt: string | null; }

function mapRow(r: ChangeRequestRow) {
  return { id: r.id, ioId: r.IoId, requestType: r.RequestType, currentValue: r.CurrentValue, requestedValue: r.RequestedValue, structuredChanges: r.StructuredChanges, reason: r.Reason, requestedBy: r.RequestedBy, status: r.Status, reviewedBy: r.ReviewedBy, reviewNote: r.ReviewNote, createdAt: r.CreatedAt, updatedAt: r.UpdatedAt }
}

export async function GET(req: Request, res: Response) {
  try {
    const status = req.query.status as string | undefined
    const ioId = req.query.ioId as string | undefined
    const conditions: string[] = [], params: unknown[] = []
    if (status) { conditions.push('Status = ?'); params.push(status) }
    if (ioId) { conditions.push('IoId = ?'); params.push(parseInt(ioId, 10)) }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db.prepare(`SELECT * FROM ChangeRequests ${whereClause} ORDER BY CreatedAt DESC`).all(...params) as ChangeRequestRow[]
    const requests = rows.map(mapRow)
    return res.json({ success: true, requests, count: requests.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}

export async function POST(req: Request, res: Response) {
  try {
    const body = req.body
    const { ioId, requestType, currentValue, requestedValue, structuredChanges, reason, requestedBy } = body

    if (!requestType || !reason || !requestedBy) {
      return res.status(400).json({ success: false, error: 'requestType, reason, and requestedBy are required' })
    }
    if (!['add', 'modify', 'remove'].includes(requestType)) {
      return res.status(400).json({ success: false, error: 'requestType must be add, modify, or remove' })
    }

    const now = new Date().toISOString()
    const result = db.prepare(`INSERT INTO ChangeRequests (IoId, RequestType, CurrentValue, RequestedValue, StructuredChanges, Reason, RequestedBy, Status, CreatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
      ioId ? parseInt(String(ioId), 10) : null, requestType, currentValue || null, requestedValue || null,
      structuredChanges ? JSON.stringify(structuredChanges) : null, reason, requestedBy, now,
    )

    const changeRequest = { id: result.lastInsertRowid as number, ioId: ioId ? parseInt(String(ioId), 10) : null, requestType, currentValue: currentValue || null, requestedValue: requestedValue || null, structuredChanges: structuredChanges ? JSON.stringify(structuredChanges) : null, reason, requestedBy, status: 'pending', createdAt: now }

    const config = await configService.getConfig()
    if (config.remoteUrl && config.apiPassword) {
      try {
        await fetch(`${config.remoteUrl}/api/sync/change-requests`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword },
          body: JSON.stringify({ requests: [{ ioId: changeRequest.ioId, subsystemId: config.subsystemId ? parseInt(String(config.subsystemId), 10) : null, requestType, currentValue: changeRequest.currentValue, requestedValue: changeRequest.requestedValue, structuredChanges: changeRequest.structuredChanges, reason, requestedBy, createdAt: now }] }),
          signal: AbortSignal.timeout(10000),
        })
      } catch (err) { console.warn('[ChangeRequest] Cloud sync failed:', err instanceof Error ? err.message : err) }
    }

    return res.json({ success: true, changeRequest })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
