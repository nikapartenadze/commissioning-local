import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { getWsBroadcastUrl } from '@/lib/plc-client-manager'
import type { CloudPullRequest, CloudPullResponse } from '@/lib/cloud/types'

/**
 * POST /api/cloud/pull
 *
 * Pull IOs from cloud PostgreSQL server and store in local SQLite.
 * This is the "Pull IOs" functionality from the config dialog.
 *
 * Request body:
 * {
 *   remoteUrl: string,      // Cloud server URL (e.g., "https://commissioning.lci.ge")
 *   subsystemId: number,    // Subsystem ID to fetch
 *   apiPassword: string     // API authentication password
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   message?: string,
 *   iosCount?: number,
 *   error?: string
 * }
 */
export async function POST(request: NextRequest): Promise<NextResponse<CloudPullResponse>> {
  try {
    const body = await request.json()
    const { remoteUrl, apiPassword } = body
    // Ensure subsystemId is a number (frontend may send as string)
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

    // Direct fetch to cloud API instead of using singleton service
    // This ensures the password is always used correctly
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
    console.log(`[CloudPull] cloudData.ios exists: ${!!cloudData.ios}, type: ${typeof cloudData.ios}`)
    console.log(`[CloudPull] cloudData.Ios exists: ${!!cloudData.Ios}, type: ${typeof cloudData.Ios}`)
    if (cloudData.ios) console.log(`[CloudPull] cloudData.ios.length: ${cloudData.ios.length}`)
    if (cloudData.Ios) console.log(`[CloudPull] cloudData.Ios.length: ${cloudData.Ios.length}`)

    // Extract IOs from response (handle both ios and Ios)
    const cloudIos = cloudData.ios || cloudData.Ios || []
    console.log(`[CloudPull] IOs extracted: ${cloudIos.length}`)
    if (cloudIos.length > 0) {
      console.log(`[CloudPull] First IO: ${JSON.stringify(cloudIos[0])}`)
    }

    if (!cloudIos || cloudIos.length === 0) {
      return NextResponse.json({
        success: true,
        message: `No IOs found for subsystem ${subsystemId}`,
        iosCount: 0,
        ioCount: 0, // Alias for frontend compatibility
        debug: {
          apiPasswordProvided: !!apiPassword,
          apiPasswordLength: apiPassword?.length || 0,
          cloudStatus: cloudResponse.status,
          cloudResponseKeys: Object.keys(cloudData),
        }
      })
    }

    console.log(`[CloudPull] Retrieved ${cloudIos.length} IOs from cloud, saving to local database...`)

    // Clear existing local data for fresh sync
    // Use transaction for atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Clear pending syncs (they're now stale)
      const deletedPending = await tx.pendingSync.deleteMany({})
      console.log(`[CloudPull] Cleared ${deletedPending.count} pending syncs`)

      // Clear existing IOs (this will cascade delete test histories)
      const deletedIos = await tx.io.deleteMany({})
      console.log(`[CloudPull] Cleared ${deletedIos.count} existing IOs`)

      // Ensure default project exists (required for subsystem foreign key)
      await tx.project.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          name: 'Default Project',
        },
        update: {},
      })

      // Ensure subsystem exists (required for IO foreign key)
      await tx.subsystem.upsert({
        where: { id: subsystemId },
        create: {
          id: subsystemId,
          name: `Subsystem ${subsystemId}`,
          projectId: 1, // Default project
        },
        update: {}, // No updates needed
      })
      console.log(`[CloudPull] Ensured subsystem ${subsystemId} exists`)

      // Insert new IOs from cloud
      let addedCount = 0
      for (const cloudIo of cloudIos) {
        // Skip IOs without valid name or ID
        if (!cloudIo.name || cloudIo.id <= 0) {
          console.warn(`[CloudPull] Skipping invalid IO: id=${cloudIo.id}, name=${cloudIo.name}`)
          continue
        }

        try {
          await tx.io.create({
            data: {
              id: cloudIo.id,
              subsystemId: subsystemId,
              name: cloudIo.name,
              description: cloudIo.description ?? null,
              order: cloudIo.order ?? null,
              result: cloudIo.result ?? null,
              timestamp: cloudIo.timestamp ?? null,
              comments: cloudIo.comments ?? null,
              version: BigInt(Number(cloudIo.version) || 0),
              tagType: cloudIo.tagType ?? null,
            },
          })
          addedCount++
        } catch (error) {
          // Log but continue - don't fail entire sync for one bad record
          console.error(`[CloudPull] Failed to insert IO ${cloudIo.id}:`, error)
        }
      }

      return addedCount
    })

    console.log(`[CloudPull] Successfully saved ${result} IOs to local database`)

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

    return NextResponse.json({
      success: true,
      message: `Successfully pulled ${result} IOs from cloud`,
      iosCount: result,
      ioCount: result, // Alias for frontend compatibility
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

    // Check for specific error types
    // NOTE: Don't use 401 for cloud auth failures - that's reserved for JWT auth
    // Using 401 would trigger authFetch to log out the user
    if (errorMessage.includes('Authentication failed') || errorMessage.includes('401')) {
      return NextResponse.json(
        { success: false, error: 'Cloud authentication failed - check API password' },
        { status: 403 }  // Use 403 Forbidden, not 401 Unauthorized
      )
    }

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    )
  }
}
