import { Request, Response } from 'express'
import { getVersionLockState } from '@/lib/update/version-lock'
import { launchUpdateInstall } from '@/lib/update/install-launcher'

/**
 * POST /api/update/install — disabled EXCEPT while version-locked.
 *
 * Self-update from the field tool is intentionally removed: the version a
 * tablet runs is controlled centrally from the cloud fleet UI (Push update),
 * never locally. This keeps every version change auditable and operator-gated
 * from one place.
 *
 * The one exception (FV-HARDENING-PLAN.md F7): when the cloud's minimum-version
 * policy has LOCKED this tool out, the lock overlay's "Update now" button posts
 * here. That path is still centrally controlled — the lock itself and the
 * target version both come from the cloud; this route only lets the operator
 * start the install without waiting for a cloud-pushed command. It shares the
 * exact pipeline with the cloud `update` command (lib/update/install-launcher).
 *
 * GET /api/update/status remains available so the tool can SHOW the lifecycle
 * of an update (read-only).
 */
export async function POST(_req: Request, res: Response) {
  const lock = getVersionLockState()
  if (!lock.locked) {
    return res.status(403).json({
      success: false,
      error: 'Local update trigger is disabled. Updates are pushed centrally from the cloud.',
    })
  }
  const outcome = await launchUpdateInstall({ trigger: 'version-lock overlay "Update now"' })
  return res.status(outcome.ok ? 200 : 502).json({
    success: outcome.ok,
    launched: outcome.launched,
    message: outcome.message,
  })
}
