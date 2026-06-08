import { Request, Response } from 'express'
import { configService } from '@/lib/config'
import { fetchCloudProjectInfo } from '@/lib/cloud/import-subsystems'

/**
 * Cloud connection config for the central tool.
 *
 * The central tool talks to ONE cloud project, and that project is identified
 * solely by the API key (X-API-Key). This is the single UI-facing place to set
 * that key + cloud URL. It is intentionally NOT admin-gated — it sits alongside
 * the other unguarded /api/mcm endpoints the landing/settings pages use, and a
 * field laptop has no admin JWT to satisfy adminMiddleware.
 *
 *  GET  /api/mcm/cloud-config
 *    -> { remoteUrl, apiKeySet, project: {ok, projectId, projectName, subsystemCount} }
 *       `project` is a live read-only probe of which project the saved key unlocks.
 *
 *  POST /api/mcm/cloud-config  { remoteUrl?, apiPassword }
 *    -> saves the creds, then re-probes and returns the resolved project so the
 *       UI can immediately show "Connected to <project> (<N> stations)" or the
 *       cloud's rejection reason.
 */
export async function GET(_req: Request, res: Response) {
  const cfg = await configService.getConfig()
  const project = await fetchCloudProjectInfo()
  return res.json({
    success: true,
    remoteUrl: cfg.remoteUrl || '',
    apiKeySet: Boolean(cfg.apiPassword),
    project,
  })
}

export async function POST(req: Request, res: Response) {
  const body = (req.body || {}) as { remoteUrl?: string; apiPassword?: string }

  if (body.apiPassword !== undefined && typeof body.apiPassword !== 'string') {
    return res.status(400).json({ success: false, error: 'apiPassword must be a string' })
  }
  if (body.remoteUrl !== undefined && typeof body.remoteUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'remoteUrl must be a string' })
  }

  const updates: { remoteUrl?: string; apiPassword?: string } = {}
  if (typeof body.remoteUrl === 'string' && body.remoteUrl.trim()) {
    updates.remoteUrl = body.remoteUrl.trim().replace(/\/+$/, '')
  }
  if (typeof body.apiPassword === 'string') {
    updates.apiPassword = body.apiPassword.trim()
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: 'Nothing to update (provide apiPassword and/or remoteUrl)' })
  }

  try {
    await configService.saveConfig(updates)
  } catch (e) {
    return res.status(500).json({ success: false, error: e instanceof Error ? e.message : 'Failed to save config' })
  }

  // Verify the freshly-saved creds against the cloud and report the project.
  const project = await fetchCloudProjectInfo()
  return res.json({ success: true, project })
}
