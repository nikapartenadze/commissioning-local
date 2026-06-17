import { db, PendingSync } from '@/lib/db-sqlite'
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import type { IoUpdateDto } from '@/lib/cloud/types'
import { auditLog } from '@/lib/logging/recovery-log'

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
  }
}

export function getOldestPendingSyncForIo(ioId: number): PendingSync | null {
  return (
    db.prepare('SELECT * FROM PendingSyncs WHERE IoId = ? ORDER BY id ASC LIMIT 1').get(ioId) as
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

  while (true) {
    const pending = getOldestPendingSyncForIo(ioId)
    if (!pending) return

    console.log(`[${logPrefix}] Attempting instant sync for pending ${pending.id} (IO ${ioId})`)

    const result = await syncService.syncIoUpdate({
      ...mapPendingSyncToIoUpdate(pending),
      testedBy: pending.InspectorName || fallbackUser || null,
    })

    if (result.ok) {
      pendingSyncRepository.delete(pending.id)
      console.log(`[${logPrefix}] Instant sync succeeded for pending ${pending.id} (IO ${ioId})`)
      continue
    }

    if (result.permanent) {
      // Permanent rejection — same payload will fail forever. Drop the row
      // now so the queue doesn't carry zombie work; the loud log was already
      // emitted inside tryRealtimeSync.
      // Recovery-critical: record the full discarded payload so the result can
      // be reconstructed/re-pushed by hand if the rejection was wrong.
      auditLog({
        type: 'sync.push.drop',
        ioId,
        version: pending.Version,
        result: pending.TestResult,
        user: pending.InspectorName,
        reason: typeof result.reason === 'string' ? result.reason : JSON.stringify(result.reason ?? 'permanent'),
        detail: {
          pendingId: pending.id,
          comments: pending.Comments,
          state: pending.State,
          failureMode: pending.FailureMode,
          timestamp: pending.Timestamp,
        },
      })
      pendingSyncRepository.delete(pending.id)
      console.warn(
        `[${logPrefix}] DROPPED-PERMANENT pendingId=${pending.id} ioId=${ioId} ` +
        `reason=${JSON.stringify(result.reason ?? 'unknown')} ` +
        `result=${JSON.stringify(pending.TestResult)} version=${pending.Version}`,
      )
      continue
    }

    console.log(
      `[${logPrefix}] Instant sync deferred for pending ${pending.id} (IO ${ioId}) — ` +
      `${result.reason ?? 'unknown'}, queued for retry`,
    )
    return
  }
}
