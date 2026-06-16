import { Request, Response } from 'express'
import { getLastFirmwareScan } from '@/lib/plc/identity/firmware-service'

/**
 * GET /api/firmware
 *
 * Return the most recent firmware scan result (or `scan: null` when no scan has
 * run yet this session). Read-only — does NOT touch the PLC; the view calls
 * POST /api/firmware/scan to gather fresh data.
 */
export async function GET(_req: Request, res: Response) {
  res.json({ scan: getLastFirmwareScan() })
}
