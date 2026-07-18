import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

/**
 * POST /api/cloud/pull-mcm-diagram
 *
 * Fetches the SCADA layout SVG for the currently configured subsystem from
 * the cloud and caches it locally in the McmDiagrams table. Called on the
 * "Pull diagram" button in the IO grid and on subsystem switch (best
 * effort — silently no-ops if cloud has nothing for this MCM yet).
 *
 * Cloud endpoint: GET /api/sync/mcm-diagram?subsystemId=X
 *
 * Response shape:
 *   { success: true, mcm: 'MCM09', updated: true|false, bytes: 12345 }
 *   { success: true, mcm: 'MCM09', updated: false, message: 'No diagram on cloud' }
 */

const upsertStmt = db.prepare(`
  INSERT INTO McmDiagrams (McmName, SvgContent, ServerUploadedAt, FetchedAt)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(McmName) DO UPDATE SET
    SvgContent = excluded.SvgContent,
    ServerUploadedAt = excluded.ServerUploadedAt,
    FetchedAt = excluded.FetchedAt
`)

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    // Honor an explicit subsystemId from the caller (the manual per-MCM pull's
    // pullExtraSections self-call passes it), falling back to the ambient config
    // subsystem for the legacy client callers (the "Pull diagram" button) that
    // send no body. Without this a central/multi-MCM tool would always pull the
    // config subsystem's diagram, not the MCM actually being pulled.
    const bodySid = (req.body as { subsystemId?: number | string } | undefined)?.subsystemId
    const subsystemId = typeof bodySid === 'number'
      ? bodySid
      : typeof bodySid === 'string'
        ? parseInt(bodySid, 10)
        : typeof config.subsystemId === 'string'
          ? parseInt(config.subsystemId, 10)
          : config.subsystemId

    if (!remoteUrl) {
      return res.status(400).json({ success: false, error: 'Cloud URL not configured' })
    }
    if (!subsystemId) {
      return res.status(400).json({ success: false, error: 'Subsystem ID not configured' })
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiPassword) headers['X-API-Key'] = apiPassword

    const url = `${remoteUrl}/api/sync/mcm-diagram?subsystemId=${subsystemId}`
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20000),
    })

    if (!response.ok) {
      if (response.status === 404) {
        return res.json({ success: true, mcm: null, updated: false, message: 'Subsystem not found on cloud' })
      }
      return res.status(502).json({ success: false, error: `Cloud returned ${response.status}` })
    }

    const data = await response.json() as {
      success?: boolean
      mcm?: string | null
      diagram?: { svgContent: string; uploadedAt: string; uploadedBy: string | null } | null
      message?: string
    }

    if (!data.mcm || !data.diagram) {
      return res.json({
        success: true,
        mcm: data.mcm ?? null,
        updated: false,
        message: data.message || 'No diagram available for this MCM',
      })
    }

    upsertStmt.run(data.mcm, data.diagram.svgContent, data.diagram.uploadedAt)

    return res.json({
      success: true,
      mcm: data.mcm,
      updated: true,
      bytes: Buffer.byteLength(data.diagram.svgContent, 'utf8'),
      uploadedAt: data.diagram.uploadedAt,
      uploadedBy: data.diagram.uploadedBy,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullMcmDiagram] Error:', message)
    return res.status(500).json({ success: false, error: message })
  }
}
