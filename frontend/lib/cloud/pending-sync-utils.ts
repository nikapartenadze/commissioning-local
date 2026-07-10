import { db, PendingSync } from '@/lib/db-sqlite'
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import type { IoUpdateDto } from '@/lib/cloud/types'
import { auditLog } from '@/lib/logging/recovery-log'
import { mcmTag } from '@/lib/logging/mcm-tag'

export function mapPendingSyncToIoUpdate(pending: PendingSync): IoUpdateDto {
  return {
    id: pending.IoId,
    testedBy: pending.InspectorName,
    result: pending.TestResult,
    comments: pending.Comments,
    state: pending.State,
    version: pending.Version,
    timestamp: pending.Timestamp ?? undefined,
    // Failure reason (lands on Io.failure_mode for filters), the
    // Dependencies Yes/No flag (read-only display on cloud), and — for
    // Unpass / explicit blocker assignment ONLY — the Blocker party +
    // description which the cloud routes to the shared Devices row.
    failureMode: pending.FailureMode ?? null,
    blockerResponsibleParty: pending.BlockerResponsibleParty ?? null,
    blockerDescription: pending.BlockerDescription ?? null,
    // Discipline (Electrical/Controls/Mechanical) → cloud Ios.trade.
    trade: pending.Trade ?? null,
    hasDependencies:
      pending.HasDependencies == null ? null : pending.HasDependencies === 1,
    // Punchlist resolver fields ride ONLY the 'Punchlist Updated' metadata op
    // (F4). Omitted (undefined → dropped by JSON) on every other op so an
    // ordinary Pass/Fail push can never clobber cloud resolver state; the
    // punchlist op itself sends explicit values incl. null-to-clear.
    ...(pending.TestResult === 'Punchlist Updated'
      ? {
          punchlistStatus: pending.PunchlistStatus ?? null,
          clarificationNote: pending.ClarificationNote ?? null,
        }
      : {}),
  }
}

export function getOldestPendingSyncForIo(ioId: number): PendingSync | null {
  // ACTIVE rows only: parked (DeadLettered=1) rows are the attention surface,
  // not work to drain — and since the permanent-reject branch below now PARKS
  // instead of deleting, including them here would spin the drain loop forever
  // on the same parked row.
  return (
    db.prepare('SELECT * FROM PendingSyncs WHERE IoId = ? AND DeadLettered = 0 ORDER BY id ASC LIMIT 1').get(ioId) as
      | PendingSync
      | undefined
  ) ?? null
}

export async function drainPendingSyncsForIo(
  ioId: number,
  logPrefix: string,
  fallbackUser?: string | null
): Promise<void> {
  const syncService = getCloudSyncService()

  // Per-MCM log tag so this IO's instant-sync lines are grep-able in the single
  // central app.log (best-effort — null subsystem yields an empty tag).
  let ioSubsystemId: number | null = null
  try {
    const ioRow = db.prepare('SELECT SubsystemId FROM Ios WHERE id = ?').get(ioId) as { SubsystemId: number | null } | undefined
    ioSubsystemId = ioRow?.SubsystemId ?? null
  } catch { /* best-effort — leave untagged */ }
  const tag = mcmTag(ioSubsystemId)

  while (true) {
    const pending = getOldestPendingSyncForIo(ioId)
    if (!pending) return

    console.log(`${tag}[${logPrefix}] Attempting instant sync for pending ${pending.id} (IO ${ioId})`)

    const result = await syncService.syncIoUpdate({
      ...mapPendingSyncToIoUpdate(pending),
      testedBy: pending.InspectorName || fallbackUser || null,
    })

    if (result.ok) {
      pendingSyncRepository.delete(pending.id)
      console.log(`${tag}[${logPrefix}] Instant sync succeeded for pending ${pending.id} (IO ${ioId})`)
      continue
    }

    if (result.permanent) {
      // Permanent rejection — same payload will fail forever. PARK the row
      // (DeadLettered=1) instead of deleting it (2026-07-08 sync-contract audit
      // P1: this instant path was the ONE place in the IO pipeline that still
      // hard-deleted on permanent reject while the background path parks —
      // park-not-delete everywhere, so a wrong rejection is recoverable from
      // the queue itself, not only from this journal line).
      // Best-effort SubsystemId so this parked result can be attributed to its
      // MCM on a central server (parity with the auto-sync drop/park audits) —
      // resolved once above and reused for both the audit and the log tag.
      const subsystemId = ioSubsystemId
      const reasonStr = typeof result.reason === 'string' ? result.reason : JSON.stringify(result.reason ?? 'permanent')
      auditLog({
        type: 'sync.push.park',
        ioId,
        subsystemId,
        version: pending.Version,
        result: pending.TestResult,
        user: pending.InspectorName,
        reason: reasonStr,
        detail: {
          pendingId: pending.id,
          comments: pending.Comments,
          state: pending.State,
          failureMode: pending.FailureMode,
          timestamp: pending.Timestamp,
        },
      })
      pendingSyncRepository.deadLetter(pending.id, `permanent reject (instant path): ${reasonStr}`)
      console.warn(
        `${tag}[${logPrefix}] PARKED-PERMANENT pendingId=${pending.id} ioId=${ioId} ` +
        `reason=${JSON.stringify(result.reason ?? 'unknown')} ` +
        `result=${JSON.stringify(pending.TestResult)} version=${pending.Version}`,
      )
      continue
    }

    console.log(
      `${tag}[${logPrefix}] Instant sync deferred for pending ${pending.id} (IO ${ioId}) — ` +
      `${result.reason ?? 'unknown'}, queued for retry`,
    )
    return
  }
}
