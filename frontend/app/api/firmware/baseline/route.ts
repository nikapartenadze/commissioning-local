import { Request, Response } from 'express'
import { getCachedBaselines } from '@/lib/cloud/firmware-baseline-sync'

/**
 * GET /api/firmware/baseline
 *
 * Returns the locally-cached approved-firmware baseline so the diagnostics view
 * can compute a per-device compliance badge client-side against the firmware it
 * already shows. Read-only; does not touch the PLC or the cloud.
 */
export async function GET(_req: Request, res: Response) {
  res.json({ baselines: getCachedBaselines() })
}
