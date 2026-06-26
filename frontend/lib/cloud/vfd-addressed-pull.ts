/**
 * Cloud→field pull of the belt-tracking ADDRESSED flag.
 *
 * A MECHANIC marks a blocked belt VFD as ADDRESSED on the CLOUD app; the field
 * tech must SEE that on the field tool's VFD Commissioning page. The field tool
 * never pushes — marking is cloud-only — so the only direction is pull.
 *
 * This does an authenticated GET to the cloud
 *   GET /api/sync/vfd-addressed?subsystemId=<id>   (header X-API-Key: <apiPassword>)
 * and UPSERTS the returned `[{ deviceName, addressed, addressedBy, addressedAt }]`
 * into the local VfdAddressed mirror (cloud-authoritative for the subsystem).
 *
 * Hooked into the SSE-reconnect catch-up in auto-sync.ts and callable on demand
 * when the VFD tab opens. Best-effort; never throws into the caller's loop.
 */

import { upsertVfdAddressedFromCloud, type CloudVfdAddressedRow } from '@/lib/db/repositories/vfd-addressed-sync-repository'

interface CloudConfig {
  remoteUrl?: string | null
  apiPassword?: string | null
}

/**
 * Pull the cloud ADDRESSED state for one subsystem and mirror it locally.
 * Returns the number of rows written, or 0 on any failure / when unconfigured.
 */
export async function pullVfdAddressed(
  subsystemId: number,
  config: CloudConfig,
): Promise<number> {
  if (!Number.isInteger(subsystemId) || subsystemId <= 0) return 0
  const remoteUrl = (config.remoteUrl ?? '').replace(/\/$/, '')
  if (!remoteUrl) return 0

  try {
    const res = await fetch(
      `${remoteUrl}/api/sync/vfd-addressed?subsystemId=${subsystemId}`,
      {
        headers: { 'X-API-Key': config.apiPassword || '' },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) {
      console.warn(`[VfdAddressedPull] subsystem ${subsystemId}: HTTP ${res.status}`)
      return 0
    }
    const data = (await res.json()) as { rows?: unknown; addressed?: unknown }
    // Tolerate either { rows: [...] } or a bare array, and { addressed: [...] }.
    const list: unknown =
      Array.isArray(data) ? data
      : Array.isArray(data?.rows) ? data.rows
      : Array.isArray(data?.addressed) ? data.addressed
      : []
    const rows: CloudVfdAddressedRow[] = (list as any[])
      .filter(r => r && typeof r.deviceName === 'string')
      .map(r => ({
        deviceName: r.deviceName,
        addressed: Boolean(r.addressed),
        addressedBy: r.addressedBy ?? null,
        addressedAt: r.addressedAt ?? null,
      }))

    return upsertVfdAddressedFromCloud(subsystemId, rows)
  } catch (err) {
    console.warn(
      `[VfdAddressedPull] subsystem ${subsystemId} failed:`,
      err instanceof Error ? err.message : err,
    )
    return 0
  }
}
