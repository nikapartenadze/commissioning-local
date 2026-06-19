import { Request, Response } from 'express'
import { scanController, scanControllers } from '@/lib/plc/identity/firmware-service'

/**
 * GET /api/firmware/controller[?subsystemId=]
 *
 * Reads the controller's firmware via a single @raw CIP Identity request and
 * returns its compliance result. The diagnostics view renders this as a
 * controller card (the controller isn't a network node, so it's not in the
 * device snapshots). Returns { controller: null } when the PLC is offline.
 *
 * Central server: the diagnostics view passes the selected MCM's subsystemId,
 * so return THAT MCM's controller (scanController() alone returns only the
 * first connected MCM's). No subsystemId → legacy single-controller behavior.
 */
export async function GET(req: Request, res: Response) {
  const sidRaw = req.query.subsystemId
  if (sidRaw != null && String(sidRaw).trim() !== '') {
    const controllers = await scanControllers()
    const match = controllers.find((c) => String(c.subsystemId) === String(sidRaw))
    return res.json({ controller: match ?? controllers[0] ?? null })
  }
  res.json({ controller: await scanController() })
}
