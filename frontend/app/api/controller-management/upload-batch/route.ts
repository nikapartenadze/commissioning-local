import { Request, Response } from 'express'
import { startBatchUploadJob, hasRunningJob } from '@/lib/logix-sdk-bridge'
import { commFrom } from '@/lib/logix-comm-path'
import { configService } from '@/lib/config/config-service'

/**
 * POST /api/controller-management/upload-batch { subsystemIds: string[] }
 * Uploads the RUNNING program from each selected controller into a NEW .acd.
 * Runs sequentially as one async job; poll /api/controller-management/job?id=.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { subsystemIds, pushToSharePoint } = req.body as { subsystemIds?: string[]; pushToSharePoint?: boolean }
    if (!Array.isArray(subsystemIds) || subsystemIds.length === 0) {
      return res.status(400).json({ error: 'subsystemIds required' })
    }
    if (hasRunningJob()) {
      return res.status(409).json({ error: 'A controller operation is already in progress — wait for it to finish.' })
    }
    if (pushToSharePoint) {
      await configService.getConfig()
      if (!configService.isSharePointConfigured()) {
        return res.status(400).json({ error: 'SharePoint not configured' })
      }
    }

    // Resolve from the CONFIGURED MCM list (config.mcms) — the authoritative
    // set — NOT the lazy mcm-registry (which only holds MCMs already connected,
    // so a configured-but-not-yet-connected controller showed "unknown ...").
    const all = await configService.getMcms()
    const targets = subsystemIds.map((id) => {
      const m = all.find((x) => String(x.subsystemId) === String(id))
      if (!m) throw new Error(`unknown controller ${id}`)
      if (!m.ip) throw new Error(`controller ${m.name || id} has no IP address`)
      return { subsystemId: String(m.subsystemId), name: m.name, comm: commFrom(m.ip, m.path || '1,0') }
    })

    const job = startBatchUploadJob(targets, { pushToSharePoint: !!pushToSharePoint })
    return res.json({ ok: job.status !== 'error', jobId: job.id, status: job.status, count: targets.length })
  } catch (error) {
    console.error('[ControllerMgmt upload-batch] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed to start batch upload' })
  }
}
