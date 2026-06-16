import { Request, Response } from 'express'
import { scanFirmware } from '@/lib/plc/identity/firmware-service'
import { syncFirmwareBaseline } from '@/lib/cloud/firmware-baseline-sync'

/**
 * POST /api/firmware/scan
 *
 * Refresh the approved-firmware baseline from the cloud (best-effort — a cloud
 * failure is non-fatal; we scan against the last-synced cache), then discover
 * reachable CIP nodes, read each one's Identity Object, and judge compliance.
 * Returns the full scan result. On-demand only (see firmware-service.ts).
 */
export async function POST(_req: Request, res: Response) {
  // Pull the latest baseline first so the verdicts reflect current cloud policy.
  // Non-fatal: if the cloud is unreachable we still scan against the cache.
  const baselineSync = await syncFirmwareBaseline()
  const scan = await scanFirmware()
  res.json({ ...scan, baselineSync })
}
