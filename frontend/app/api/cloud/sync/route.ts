import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { ioRepository } from '@/lib/db/repositories/io-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import type { IoUpdateDto, SyncResult } from '@/lib/cloud/types'

/**
 * POST /api/cloud/sync
 *
 * Sync pending test results to cloud.
 * Processes the offline queue (PendingSyncs table) and syncs to cloud server.
 *
 * Request body (optional):
 * {
 *   remoteUrl?: string,     // Cloud server URL (uses stored config if not provided)
 *   apiPassword?: string,   // API authentication password
 *   batchSize?: number,     // Number of records per batch (default: 50)
 *   force?: boolean         // Force sync even if recently attempted
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   syncedCount: number,
 *   failedCount: number,
 *   errors?: string[]
 * }
 */
export async function POST(request: NextRequest): Promise<NextResponse<SyncResult>> {
  try {
    const body = await request.json().catch(() => ({}))
    const { remoteUrl, apiPassword, batchSize = 50, force = false } = body

    console.log('[CloudSync] Starting pending sync processing...')

    // Get pending syncs from database
    const pendingSyncs = await pendingSyncRepository.getAll()

    if (pendingSyncs.length === 0) {
      console.log('[CloudSync] No pending syncs to process')
      return NextResponse.json({
        success: true,
        syncedCount: 0,
        failedCount: 0,
      })
    }

    console.log(`[CloudSync] Found ${pendingSyncs.length} pending syncs`)

    // Initialize cloud sync service
    const cloudSyncService = getCloudSyncService()

    // Update config if provided
    if (remoteUrl || apiPassword) {
      cloudSyncService.updateConfig({
        ...(remoteUrl && { remoteUrl }),
        ...(apiPassword && { apiPassword }),
        batchSize,
      })
    }

    // Check cloud availability
    const isAvailable = await cloudSyncService.isCloudAvailable()
    if (!isAvailable && !force) {
      console.warn('[CloudSync] Cloud not available, keeping items in queue')
      return NextResponse.json({
        success: false,
        syncedCount: 0,
        failedCount: pendingSyncs.length,
        errors: ['Cloud server is not reachable'],
      })
    }

    // Process pending syncs with version control
    const result = await cloudSyncService.syncPendingUpdatesWithVersionControl(
      async (ioId: number) => {
        const io = await ioRepository.getById(ioId)
        if (!io) return null
        return {
          id: io.id,
          subsystemId: io.subsystemId,
          name: io.name ?? '',
          description: io.description,
          result: io.result,
          timestamp: io.timestamp,
          comments: io.comments,
          order: io.order,
          version: io.version,
          tagType: io.tagType,
        }
      }
    )

    // Also process any pending syncs that weren't in the in-memory queue
    // (could happen if service was restarted)
    const remainingPending = await pendingSyncRepository.getAll()
    const processedIds = new Set([
      ...result.successfulIds,
      ...result.failedIds,
      ...result.rejectedIds,
    ])

    const unprocessed = remainingPending.filter((p) => !processedIds.has(p.ioId))

    if (unprocessed.length > 0) {
      console.log(`[CloudSync] Processing ${unprocessed.length} unprocessed pending syncs from database`)

      for (const pending of unprocessed) {
        const update: IoUpdateDto = {
          id: pending.ioId,
          testedBy: pending.inspectorName,
          result: pending.testResult,
          comments: pending.comments,
          state: pending.state,
          version: Number(pending.version),
          timestamp: pending.timestamp?.toISOString(),
        }

        const synced = await cloudSyncService.syncIoUpdate(update)

        if (synced) {
          result.successfulIds.push(pending.ioId)
          // Remove from database
          await pendingSyncRepository.delete(pending.id)
        } else {
          result.failedIds.push(pending.ioId)
          // Increment retry count
          await pendingSyncRepository.recordFailure(pending.id, 'Sync failed')
        }
      }
    }

    // Remove synced items from database
    if (result.successfulIds.length > 0) {
      const pendingToDelete = await prisma.pendingSync.findMany({
        where: { ioId: { in: result.successfulIds } },
        select: { id: true },
      })
      await pendingSyncRepository.deleteMany(pendingToDelete.map((p) => p.id))
    }

    // Remove rejected items from database
    if (result.rejectedIds.length > 0) {
      const pendingToDelete = await prisma.pendingSync.findMany({
        where: { ioId: { in: result.rejectedIds } },
        select: { id: true },
      })
      await pendingSyncRepository.deleteMany(pendingToDelete.map((p) => p.id))
    }

    console.log(
      `[CloudSync] Sync complete: ${result.successfulIds.length} synced, ${result.failedIds.length} failed, ${result.rejectedIds.length} rejected`
    )

    // Collect errors for response
    const errors: string[] = []
    result.errors.forEach((error, ioId) => {
      errors.push(`IO ${ioId}: ${error}`)
    })

    return NextResponse.json({
      success: result.failedIds.length === 0,
      syncedCount: result.successfulIds.length,
      failedCount: result.failedIds.length + result.rejectedIds.length,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error('[CloudSync] Error processing pending syncs:', error)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

    return NextResponse.json(
      {
        success: false,
        syncedCount: 0,
        failedCount: 0,
        errors: [errorMessage],
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/cloud/sync
 *
 * Get sync status and statistics.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const stats = await pendingSyncRepository.getStats()
    const cloudSyncService = getCloudSyncService()

    return NextResponse.json({
      pendingCount: stats.total,
      failedCount: stats.failed,
      maxRetries: stats.maxRetries,
      oldestPending: stats.oldestTimestamp?.toISOString() ?? null,
      connectionState: cloudSyncService.connectionState,
      isConnected: cloudSyncService.isConnected,
    })
  } catch (error) {
    console.error('[CloudSync] Error getting sync status:', error)
    return NextResponse.json(
      { error: 'Failed to get sync status' },
      { status: 500 }
    )
  }
}
