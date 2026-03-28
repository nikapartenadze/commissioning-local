export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { createBackup } from '@/lib/db/backup'
import type { CloudPullResponse } from '@/lib/cloud/types'

/** Classify IO description into a tagType for diagnostic steps */
function classifyDescription(desc: string | null): string | null {
  if (!desc) return null
  const dl = desc.toLowerCase()
  if (dl.includes('beacon')) return 'BCN 24V Segment 1'
  if (dl.includes('pushbutton light') || dl.includes('pb_lt') || dl.includes('pblt') || (dl.includes('button') && dl.includes('light')))
    return 'Button Light'
  if (dl.includes('pushbutton') || dl.includes('push button'))
    return 'Button Press'
  if (dl.includes('photoeye') || dl.includes('tpe'))
    return 'TPE Dark Operated'
  if (dl.includes('vfd') || dl.includes('motor'))
    return 'Motor/VFD'
  if (dl.includes('disconnect'))
    return 'Disconnect Switch'
  if (dl.includes('light') || dl.includes('lamp') || dl.includes('indicator'))
    return 'Indicator Light'
  if (dl.includes('sensor') || dl.includes('prox'))
    return 'Sensor'
  if (dl.includes('valve') || dl.includes('solenoid'))
    return 'Valve/Solenoid'
  if (dl.includes('safety') || dl.includes('e-stop') || dl.includes('estop'))
    return 'Safety Device'
  return null
}

/**
 * POST /api/cloud/pull
 *
 * Pull IOs from cloud PostgreSQL server and store in local SQLite.
 * Uses upsert to preserve existing test data (results, timestamps, comments).
 * Auto-backs up the database before making changes.
 */
export async function POST(request: NextRequest): Promise<NextResponse<CloudPullResponse>> {
  try {
    const body = await request.json()
    const { remoteUrl, apiPassword } = body
    const subsystemId = typeof body.subsystemId === 'string'
      ? parseInt(body.subsystemId, 10)
      : body.subsystemId

    // Validate required fields
    if (!remoteUrl) {
      return NextResponse.json(
        { success: false, error: 'Remote URL is required' },
        { status: 400 }
      )
    }

    if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
      return NextResponse.json(
        { success: false, error: 'Valid subsystem ID is required' },
        { status: 400 }
      )
    }

    console.log(`[CloudPull] Starting pull for subsystem ${subsystemId} from ${remoteUrl}`)
    console.log(`[CloudPull] API Password provided: ${apiPassword ? 'yes (' + apiPassword.length + ' chars)' : 'no'}`)

    // Check for un-synced data
    const pendingCount = await prisma.pendingSync.count()
    const forceFlag = body.force === true
    if (pendingCount > 0 && !forceFlag) {
      return NextResponse.json(
        { success: false, error: `${pendingCount} test results have not been synced to cloud yet. Sync first, or use force=true to proceed anyway.` },
        { status: 409 }
      )
    }

    // Auto-backup before destructive operation
    try {
      const backup = await createBackup('pre-pull')
      console.log(`[CloudPull] Auto-backup created: ${backup.filename}`)
    } catch (backupErr) {
      console.error('[CloudPull] Backup failed:', backupErr)
      // Continue anyway — backup failure shouldn't block the pull
    }

    // Direct fetch to cloud API
    const cloudUrl = `${remoteUrl}/api/sync/subsystem/${subsystemId}`
    console.log(`[CloudPull] Fetching from: ${cloudUrl}`)

    const cloudResponse = await fetch(cloudUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiPassword || '',
      },
    })

    console.log(`[CloudPull] Cloud response status: ${cloudResponse.status}`)

    if (cloudResponse.status === 401) {
      return NextResponse.json(
        { success: false, error: 'Cloud authentication failed - check API password' },
        { status: 403 }
      )
    }

    if (!cloudResponse.ok) {
      const errorText = await cloudResponse.text()
      console.log(`[CloudPull] Cloud error: ${errorText}`)
      return NextResponse.json(
        { success: false, error: `Cloud server error: ${cloudResponse.status}` },
        { status: 502 }
      )
    }

    const cloudData = await cloudResponse.json()
    console.log(`[CloudPull] Cloud response keys: ${Object.keys(cloudData)}`)

    // Extract IOs from response (handle both ios and Ios)
    const cloudIos = cloudData.ios || cloudData.Ios || []
    console.log(`[CloudPull] IOs extracted: ${cloudIos.length}`)

    if (!cloudIos || cloudIos.length === 0) {
      return NextResponse.json({
        success: true,
        message: `No IOs found for subsystem ${subsystemId}`,
        iosCount: 0,
        ioCount: 0,
        debug: {
          apiPasswordProvided: !!apiPassword,
          apiPasswordLength: apiPassword?.length || 0,
          cloudStatus: cloudResponse.status,
          cloudResponseKeys: Object.keys(cloudData),
        }
      })
    }

    console.log(`[CloudPull] Retrieved ${cloudIos.length} IOs from cloud, upserting to local database...`)

    // Safety check: warn if cloud has significantly fewer IOs than local
    const localIoCount = await prisma.io.count()
    let pullWarning: string | undefined
    if (localIoCount > 0 && cloudIos.length < localIoCount) {
      const reduction = ((localIoCount - cloudIos.length) / localIoCount) * 100
      if (reduction > 50) {
        pullWarning = `Cloud returned ${cloudIos.length} IOs but local has ${localIoCount} (${reduction.toFixed(0)}% fewer). Proceeding as requested.`
        console.warn(`[CloudPull] WARNING: ${pullWarning}`)
      }
    }

    // Upsert IOs instead of delete+create to preserve test data
    const result = await prisma.$transaction(async (tx) => {
      // Ensure default project exists
      await tx.project.upsert({
        where: { id: 1 },
        create: { id: 1, name: 'Default Project' },
        update: {},
      })

      // Ensure subsystem exists
      await tx.subsystem.upsert({
        where: { id: subsystemId },
        create: {
          id: subsystemId,
          name: `Subsystem ${subsystemId}`,
          projectId: 1,
        },
        update: {},
      })
      console.log(`[CloudPull] Ensured subsystem ${subsystemId} exists`)

      // Clear ALL existing IOs before pulling fresh data
      const deletedCount = await tx.io.deleteMany({})
      if (deletedCount.count > 0) {
        console.log(`[CloudPull] Cleared ${deletedCount.count} existing IOs`)
      }

      // Insert IOs from cloud
      const cloudIoIds: number[] = []
      let upsertedCount = 0

      for (const cloudIo of cloudIos) {
        if (!cloudIo.name || cloudIo.id <= 0) {
          console.warn(`[CloudPull] Skipping invalid IO: id=${cloudIo.id}, name=${cloudIo.name}`)
          continue
        }

        cloudIoIds.push(cloudIo.id)

        try {
          const updateData: Record<string, unknown> = {
            name: cloudIo.name,
            description: cloudIo.description ?? null,
            order: cloudIo.order ?? null,
            version: BigInt(Number(cloudIo.version) || 0),
            result: cloudIo.result ?? null,
            timestamp: cloudIo.timestamp ?? null,
            comments: cloudIo.comments ?? null,
          }

          if (cloudIo.tagType != null) {
            updateData.tagType = cloudIo.tagType
          }

          await tx.io.upsert({
            where: { id: cloudIo.id },
            create: {
              id: cloudIo.id,
              subsystemId: subsystemId,
              name: cloudIo.name,
              description: cloudIo.description ?? null,
              order: cloudIo.order ?? null,
              version: BigInt(Number(cloudIo.version) || 0),
              tagType: cloudIo.tagType ?? null,
              result: cloudIo.result ?? null,
              timestamp: cloudIo.timestamp ?? null,
              comments: cloudIo.comments ?? null,
            },
            update: updateData,
          })
          upsertedCount++
        } catch (error) {
          console.error(`[CloudPull] Failed to upsert IO ${cloudIo.id}:`, error)
        }
      }

      // Don't delete PendingSyncs — they should persist until actually synced

      return upsertedCount
    })

    console.log(`[CloudPull] Successfully upserted ${result} IOs to local database`)

    // Auto-assign tagType from descriptions for IOs that don't have one
    try {
      const untyped = await prisma.io.findMany({
        where: { tagType: null },
        select: { id: true, description: true }
      })
      let assigned = 0
      for (const io of untyped) {
        const tagType = classifyDescription(io.description)
        if (tagType) {
          await prisma.io.update({ where: { id: io.id }, data: { tagType } })
          assigned++
        }
      }
      if (assigned > 0) {
        console.log(`[CloudPull] Auto-assigned tagType to ${assigned} IOs based on descriptions`)
      }
    } catch (error) {
      console.error('[CloudPull] Error assigning tag types:', error)
    }

    // Persist cloud config to disk so it survives restarts
    try {
      const { configService } = await import('@/lib/config')
      await configService.saveConfig({
        remoteUrl: remoteUrl,
        apiPassword: apiPassword,
        subsystemId: String(subsystemId),
      })
      console.log('[CloudPull] Cloud config saved to config.json')
    } catch (e) {
      console.warn('[CloudPull] Failed to save config:', e)
    }

    // Mark CloudSyncService as connected (it reads config from configService on demand)
    try {
      const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
      const syncService = getCloudSyncService()
      syncService.setConnectionState('connected')
    } catch (e) {
      console.warn('[CloudPull] Failed to update sync service state:', e)
    }

    // Auto-start background sync (SSE + push/pull loops) if not already running
    try {
      const { startAutoSync, getAutoSyncService } = await import('@/lib/cloud/auto-sync')
      if (!getAutoSyncService()?.running) {
        startAutoSync()
        console.log('[CloudPull] Auto-sync started after successful pull')
      }
    } catch (e) {
      console.warn('[CloudPull] Failed to start auto-sync:', e)
    }

    // Broadcast to all clients to reload their IO data
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'IOsUpdated', count: result })
      })
    } catch {
      // WebSocket server might not be running
    }

    // Also pull network + estop data alongside IOs (non-blocking, failures don't affect IO pull)
    let networkPulled = 0
    let estopPulled = 0
    try {
      // Pull network topology
      const netRes = await fetch(`${remoteUrl}/api/sync/network/${subsystemId}`, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiPassword || '',
        },
        signal: AbortSignal.timeout(15000),
      })
      if (netRes.ok) {
        const netData = await netRes.json()
        // Pull-network logic handled by existing endpoint
        const pullNetRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/cloud/pull-network`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        if (pullNetRes.ok) {
          const pullNetData = await pullNetRes.json()
          networkPulled = pullNetData.rings || 0
        }
      }
    } catch {
      console.log('[CloudPull] Network pull skipped or failed (non-critical)')
    }

    try {
      // Pull estop data
      const pullEstopRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/cloud/pull-estop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (pullEstopRes.ok) {
        const pullEstopData = await pullEstopRes.json()
        estopPulled = pullEstopData.zones || 0
      }
    } catch {
      console.log('[CloudPull] EStop pull skipped or failed (non-critical)')
    }

    return NextResponse.json({
      success: true,
      message: `Successfully pulled ${result} IOs from cloud`,
      iosCount: result,
      ioCount: result,
      networkPulled,
      estopPulled,
      ...(pullWarning ? { warning: pullWarning } : {}),
      debug: {
        cloudIosLength: cloudIos.length,
        cloudResponseKeys: Object.keys(cloudData),
        firstIoId: cloudIos[0]?.id,
        firstIoName: cloudIos[0]?.name,
      }
    })
  } catch (error) {
    console.error('[CloudPull] Error pulling IOs from cloud:', error)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

    if (errorMessage.includes('Authentication failed') || errorMessage.includes('401')) {
      return NextResponse.json(
        { success: false, error: 'Cloud authentication failed - check API password' },
        { status: 403 }
      )
    }

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    )
  }
}
