import { Request, Response } from 'express'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL, type PlcProfile } from '@/lib/config/types'
import { noteCloudProjectId } from '@/lib/sync/cloud-project'

/**
 * GET /api/subsystems/list
 *
 * Returns the MCM picker list — one row per subsystem in the active project,
 * with any locally-saved PLC IP/path merged in. Used by the setup page and
 * the PLC config dialog instead of having technicians type subsystem IDs.
 *
 * Source layering (highest priority wins):
 *   1. Cloud `/api/sync/subsystems` — canonical names + IDs, scoped to the
 *      project that owns the configured apiPassword. Single source of truth
 *      for what subsystems exist.
 *   2. Local `config.json` → `plcProfiles[]` — fills in plcIp/plcPath for any
 *      subsystemId the operator has connected to before, plus any names a
 *      site admin pre-configured for an offline-first first-run.
 *
 * If the cloud is unreachable we fall back to whatever plcProfiles[] holds,
 * so the field tool stays usable in disconnected environments.
 */
export async function GET(req: Request, res: Response) {
  const config = await configService.getConfig()
  const localProfiles: PlcProfile[] = Array.isArray((config as any).plcProfiles)
    ? ((config as any).plcProfiles as PlcProfile[])
    : []

  const profileByIdLocal = new Map<string, PlcProfile>(
    localProfiles
      .filter((p) => p && typeof p.subsystemId === 'string' && p.subsystemId.length > 0)
      .map((p) => [String(p.subsystemId), p]),
  )

  let cloudReachable = false
  let cloudError: string | undefined
  let projectName: string | undefined
  const remoteUrl = EMBEDDED_REMOTE_URL
  // Caller can override the apiPassword via query param so the dialog can
  // preview a different project's MCM list before committing the password
  // to config.json. Falls back to the saved password when not provided.
  const overrideApiPassword = typeof req.query.apiPassword === 'string'
    ? String(req.query.apiPassword)
    : ''
  const apiPassword = overrideApiPassword || config.apiPassword || ''

  // ── Cloud fetch (best-effort) ───────────────────────────────────
  type CloudSubsystem = { id: number | string; name: string }
  let cloudSubsystems: CloudSubsystem[] = []

  if (apiPassword) {
    try {
      const controller = new AbortController()
      // 3s (was 10s — 2026-07-08 offline audit): the picker blocked the setup
      // page for the full timeout when the cloud URL was blackholed. A live
      // cloud answers this list in well under 3s; offline falls back to local
      // plcProfiles 7s sooner.
      const timeout = setTimeout(() => controller.abort(), 3_000)
      const cloudRes = await fetch(`${remoteUrl}/api/sync/subsystems`, {
        method: 'GET',
        headers: { 'X-API-Key': apiPassword },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (cloudRes.ok) {
        const json = (await cloudRes.json()) as {
          projectId?: number
          projectName?: string
          subsystems?: CloudSubsystem[]
        }
        // This route runs on ordinary setup/picker traffic, so it is the most
        // frequently-hit place the cloud tells us which project the API key
        // unlocks. Bank it for held-back telemetry attribution — see
        // lib/sync/cloud-project.ts. Best-effort, never affects the response.
        noteCloudProjectId(json.projectId)
        cloudReachable = true
        projectName = json.projectName
        cloudSubsystems = Array.isArray(json.subsystems) ? json.subsystems : []
      } else {
        cloudError = `HTTP ${cloudRes.status}`
      }
    } catch (err) {
      cloudError = err instanceof Error ? err.message : String(err)
    }
  } else {
    cloudError = 'No apiPassword configured'
  }

  // ── Merge ───────────────────────────────────────────────────────
  // When cloud is reachable, it owns the canonical list of names+IDs.
  // Local config only contributes plcIp/plcPath enrichment per subsystem.
  // When cloud is unreachable, fall back to local profiles entirely.
  const merged: PlcProfile[] = cloudReachable
    ? cloudSubsystems.map((s) => {
        const subsystemId = String(s.id)
        const local = profileByIdLocal.get(subsystemId)
        return {
          // Cloud owns the canonical display name (e.g. "MCM08"). Local
          // only contributes name when cloud returned an empty string
          // (rare — unnamed subsystem in the database). This avoids
          // freezing placeholder names like "Subsystem 37" in the picker
          // forever after a one-time upsert from a pre-cloud-aware build.
          name: s.name || local?.name || `Subsystem ${subsystemId}`,
          subsystemId,
          plcIp: local?.plcIp || '',
          plcPath: local?.plcPath || '1,0',
        }
      })
    : localProfiles

  return res.json({
    source: cloudReachable ? 'cloud' : 'local',
    projectName,
    cloudError: cloudReachable ? undefined : cloudError,
    subsystems: merged,
  })
}
