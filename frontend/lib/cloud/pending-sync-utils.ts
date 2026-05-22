import { db, PendingSync } from '@/lib/db-sqlite'
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import type { IoUpdateDto } from '@/lib/cloud/types'

export function mapPendingSyncToIoUpdate(pending: PendingSync): IoUpdateDto {
  return {
    id: pending.IoId,
    testedBy: pending.InspectorName,
    result: pending.TestResult,
    comments: pending.Comments,
    state: pending.State,
    version: pending.Version,
    timestamp: pending.Timestamp ?? undefined,
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
