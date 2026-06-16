import { Request, Response } from 'express'
import { scanController } from '@/lib/plc/identity/firmware-service'

/**
 * GET /api/firmware/controller
 *
 * Reads the controller's firmware via a single @raw CIP Identity request and
 * returns its compliance result. The diagnostics view renders this as a
 * controller card (the controller isn't a network node, so it's not in the
 * device snapshots). Returns { controller: null } when the PLC is offline.
 */
export async function GET(_req: Request, res: Response) {
  res.json({ controller: await scanController() })
}
