/**
 * Approved-firmware baseline sync (cloud → local cache).
 *
 * The cloud is the source of truth for which firmware revisions are approved
 * per device model. We pull that list and cache it in the local ApprovedFirmware
 * table so firmware compliance evaluates OFFLINE against the last-synced
 * baseline. Pulled on PLC connect/reconnect and on demand from the firmware view.
 *
 * Cloud endpoint: GET {remoteUrl}/api/firmware/approved  (header X-API-Key)
 * Returns: [{ vendorId, productCode, modelName?, minRevMajor, minRevMinor,
 *            notes?, updatedBy?, updatedAt? }]
 *
 * See docs/superpowers/specs/2026-06-16-firmware-compliance-design.md.
 */

import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config/config-service'
import type { FirmwareBaseline } from '@/lib/plc/identity/compliance'

export interface BaselineSyncResult {
  ok: boolean
  /** Number of baseline entries cached on success. */
  count?: number
  error?: string
}

/** Read the locally-cached approved-firmware baseline (offline source). */
export function getCachedBaselines(): FirmwareBaseline[] {
  const rows = db
    .prepare('SELECT VendorId, ProductCode, ModelName, MinRevMajor, MinRevMinor FROM ApprovedFirmware')
    .all() as Array<{
      VendorId: number
      ProductCode: number
      ModelName: string | null
      MinRevMajor: number
      MinRevMinor: number
    }>
  return rows.map((r) => ({
    vendorId: r.VendorId,
    productCode: r.ProductCode,
    modelName: r.ModelName ?? undefined,
    minRevMajor: r.MinRevMajor,
    minRevMinor: r.MinRevMinor,
  }))
}

let lastSyncAt: number | null = null

/** ms since epoch of the most recent successful baseline pull, or null. */
export function getLastBaselineSyncAt(): number | null {
  return lastSyncAt
}

interface CloudBaselineRow {
  vendorId: number
  productCode: number
  modelName?: string | null
  minRevMajor: number
  minRevMinor: number
  notes?: string | null
  updatedBy?: string | null
  updatedAt?: string | null
}

/**
 * Pull the approved-firmware baseline from the cloud and replace the local
 * cache wholesale (inside one transaction). Best-effort: on any network/cloud
 * error the existing cache is left intact and the error is returned — the
 * field tool keeps evaluating against whatever it last synced.
 */
export async function syncFirmwareBaseline(): Promise<BaselineSyncResult> {
  const cfg = await configService.getConfig()
  const remoteUrl = (cfg.remoteUrl || '').replace(/\/+$/, '')
  const apiPassword = cfg.apiPassword || ''

  if (!remoteUrl) return { ok: false, error: 'Cloud URL not configured' }
  if (!apiPassword) return { ok: false, error: 'API key not configured' }

  let res: Response
  try {
    res = await fetch(`${remoteUrl}/api/firmware/approved`, {
      method: 'GET',
      headers: { 'X-API-Key': apiPassword },
    })
  } catch (err) {
    return { ok: false, error: `Cloud unreachable: ${(err as Error).message}` }
  }
  if (!res.ok) return { ok: false, error: `Cloud returned ${res.status}` }

  let rows: CloudBaselineRow[]
  try {
    const body = await res.json()
    rows = Array.isArray(body) ? body : (body?.items ?? [])
  } catch {
    return { ok: false, error: 'Malformed baseline response' }
  }

  // Validate + coerce before touching the cache so a bad row can't half-write.
  const clean = rows
    .filter((r) => Number.isFinite(r?.vendorId) && Number.isFinite(r?.productCode)
      && Number.isFinite(r?.minRevMajor) && Number.isFinite(r?.minRevMinor))
    .map((r) => ({
      vendorId: Math.trunc(r.vendorId),
      productCode: Math.trunc(r.productCode),
      modelName: r.modelName ?? null,
      minRevMajor: Math.trunc(r.minRevMajor),
      minRevMinor: Math.trunc(r.minRevMinor),
      notes: r.notes ?? null,
      updatedBy: r.updatedBy ?? null,
      updatedAt: r.updatedAt ?? null,
    }))

  const replaceAll = db.transaction((items: typeof clean) => {
    db.prepare('DELETE FROM ApprovedFirmware').run()
    const ins = db.prepare(
      `INSERT INTO ApprovedFirmware
         (VendorId, ProductCode, ModelName, MinRevMajor, MinRevMinor, Notes, UpdatedBy, UpdatedAt)
       VALUES (@vendorId, @productCode, @modelName, @minRevMajor, @minRevMinor, @notes, @updatedBy, @updatedAt)`,
    )
    for (const it of items) ins.run(it)
  })
  replaceAll(clean)

  lastSyncAt = Date.now()
  return { ok: true, count: clean.length }
}
