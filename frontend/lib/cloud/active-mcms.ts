import { configService } from '@/lib/config'

/**
 * Which MCMs are ACTIVE for sync/telemetry purposes, and whether this box is
 * running in central (multi-MCM / split-gateway) mode.
 *
 * This predicate is a data-safety rule — it decides which MCMs get pushed —
 * and after the auto-sync god-file split it existed as five drifting copies
 * (3× byte-identical in auto-sync-telemetry.ts, variants in auto-sync-pull.ts
 * and result-reconciler.ts). One definition, everywhere (2026-07-12).
 */
type Mcms = Awaited<ReturnType<typeof configService.getMcms>>

export function isActiveMcm(m: { enabled?: boolean; subsystemId?: string; ip?: string }): boolean {
  return m.enabled !== false && !!m.subsystemId && !!m.ip && !!m.ip.trim()
}

export async function resolveActiveMcms(): Promise<{
  active: Mcms
  remoteMode: boolean
  centralMode: boolean
}> {
  let mcms: Mcms = []
  try { mcms = await configService.getMcms() } catch { mcms = [] }
  const active = mcms.filter(isActiveMcm)
  const remoteMode = process.env.PLC_MODE === 'remote'
  const centralMode = remoteMode || active.length > 1
  return { active, remoteMode, centralMode }
}
