/**
 * Cloud→field pull of VFD commissioning BLOCKERS.
 *
 * A blocker ("belt slipping / not moving — Mechanical") raised on ONE field box
 * flows UP to the cloud but, historically, never came back DOWN to the other
 * boxes — so each box saw a different blocked/ready picture (the 2026-07-16
 * MCM15 divergence). This is the missing symmetric half of the ADDRESSED pull:
 * it mirrors the cloud's authoritative blocker set for a subsystem into the
 * local VfdBlocker mirror so every box shows the same blocked belts.
 *
 * Authenticated GET to the cloud:
 *   GET /api/sync/vfd-blockers?subsystemId=<id>   (header X-API-Key: <apiPassword>)
 * UPSERTS the returned blockers into the local mirror (cloud-authoritative for
 * the subsystem), never clobbering a device with an in-flight local blocker op.
 *
 * Hooked into the SSE-delta reaction (the vfdBlocker section), the SSE-reconnect
 * catch-up, the periodic delta sweep, and callable on demand when the VFD tab
 * opens. Best-effort; never throws into the caller's loop.
 */

import {
  applyVfdBlockersFromCloud,
  type CloudVfdBlockerRow,
} from '@/lib/db/repositories/vfd-blocker-mirror-repository'

interface CloudConfig {
  remoteUrl?: string | null
  apiPassword?: string | null
}

/**
 * Pull the cloud BLOCKER state for one subsystem and mirror it locally.
 * Returns the number of rows written, or 0 on any failure / when unconfigured.
 */
export async function pullVfdBlockers(
  subsystemId: number,
  config: CloudConfig,
): Promise<number> {
  if (!Number.isInteger(subsystemId) || subsystemId <= 0) return 0
  const remoteUrl = (config.remoteUrl ?? '').replace(/\/$/, '')
  if (!remoteUrl) return 0

  try {
    const res = await fetch(
      `${remoteUrl}/api/sync/vfd-blockers?subsystemId=${subsystemId}`,
      {
        headers: { 'X-API-Key': config.apiPassword || '' },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) {
      console.warn(`[VfdBlockersPull] subsystem ${subsystemId}: HTTP ${res.status}`)
      return 0
    }
    const data = (await res.json()) as { blockers?: unknown; rows?: unknown }
    // Tolerate either { blockers: [...] }, { rows: [...] }, or a bare array.
    const list: unknown =
      Array.isArray(data) ? data
      : Array.isArray(data?.blockers) ? data.blockers
      : Array.isArray(data?.rows) ? data.rows
      : []
    const rows: CloudVfdBlockerRow[] = (list as any[])
      .filter(r => r && typeof r.deviceName === 'string')
      .map(r => ({
        deviceName: r.deviceName,
        party: r.party ?? null,
        description: r.description ?? null,
        updatedBy: r.updatedBy ?? null,
        updatedAt: r.updatedAt ?? null,
        addressedBy: r.addressedBy ?? null,
        addressedAt: r.addressedAt ?? null,
      }))

    return applyVfdBlockersFromCloud(subsystemId, rows)
  } catch (err) {
    console.warn(
      `[VfdBlockersPull] subsystem ${subsystemId} failed:`,
      err instanceof Error ? err.message : err,
    )
    return 0
  }
}
