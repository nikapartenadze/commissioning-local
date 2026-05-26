import { Request, Response } from 'express'

/**
 * POST /api/update/install — DISABLED.
 *
 * Self-update from the field tool is intentionally removed: the version a
 * tablet runs is controlled centrally from the cloud fleet UI (Push update),
 * never locally. This keeps every version change auditable and operator-gated
 * from one place. The actual install pipeline still lives in
 * lib/heartbeat/command-handler.ts (the cloud `update` command) — this HTTP
 * route is only the old in-app "Install On Host" entry point, now neutered so
 * it can't be triggered from the tablet (UI button removed) or by curling it.
 *
 * GET /api/update/status remains available so the tool can still SHOW the
 * lifecycle of a cloud-pushed update (read-only).
 */
export async function POST(_req: Request, res: Response) {
  return res.status(403).json({
    success: false,
    error: 'Local update trigger is disabled. Updates are pushed centrally from the cloud.',
  })
}
