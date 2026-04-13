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

    const synced = await syncService.syncIoUpdate({
      ...mapPendingSyncToIoUpdate(pending),
      testedBy: pending.InspectorName || fallbackUser || null,
    })

    if (!synced) {
      console.log(`[${logPrefix}] Instant sync returned false for pending ${pending.id} (IO ${ioId}) — queued for retry`)
      return
    }

    pendingSyncRepository.delete(pending.id)
    console.log(`[${logPrefix}] Instant sync succeeded for pending ${pending.id} (IO ${ioId})`)
  }
}
