export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getPlcTags } from '@/lib/plc-client-manager'
import { createTimestamp, TEST_CONSTANTS } from '@/lib/services/io-test-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/ios/[id]/reset
 * Reset/clear IO test result to null
 *
 * Request body (optional):
 * {
 *   currentUser?: string
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { id } = await params
    const ioId = parseInt(id)

    if (isNaN(ioId)) {
      return NextResponse.json({ error: 'Invalid IO ID' }, { status: 400 })
    }

    let currentUser = 'Unknown'
    try {
      const body = await request.json()
      if (body.currentUser) {
        currentUser = body.currentUser
      }
    } catch {
      // Empty body is OK
    }

    const io = await prisma.io.findUnique({
      where: { id: ioId }
    })

    if (!io) {
      return NextResponse.json({ error: 'IO not found' }, { status: 404 })
    }

    // Check if already cleared
    const hadComments = !!io.comments
    const hadResult = !!io.result

    if (!hadComments && !hadResult) {
      // Already cleared, nothing to do
      return NextResponse.json({
        success: true,
        message: 'IO already cleared',
        io: {
          id: io.id,
          subsystemId: io.subsystemId,
          name: io.name,
          description: io.description,
          result: io.result,
          timestamp: io.timestamp,
          comments: io.comments,
          order: io.order,
          version: io.version.toString(),
          state: null
        }
      })
    }

    // Get current PLC state
    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)
    const plcState = tag?.state

    // Build history comment
    let historyComment: string | null = null
    if (hadResult && hadComments) {
      historyComment = io.comments
    } else if (hadResult) {
      historyComment = `Cleared ${io.result} result`
    } else {
      historyComment = 'Cleared comments'
    }

    const timestamp = createTimestamp()

    // Clear IO and create history in transaction
    const [updatedIo, testHistory] = await prisma.$transaction([
      prisma.io.update({
        where: { id: ioId },
        data: {
          result: null,
          timestamp: null,
          comments: null,
          version: { increment: 1 }
        }
      }),
      prisma.testHistory.create({
        data: {
          ioId,
          result: TEST_CONSTANTS.RESULT_CLEARED,
          timestamp,
          comments: historyComment,
          state: plcState,
          testedBy: currentUser
        }
      })
    ])

    // Create PendingSync entry as fallback, then attempt immediate cloud sync
    try {
      const pendingSync = await prisma.pendingSync.create({
        data: {
          ioId,
          inspectorName: currentUser || null,
          testResult: TEST_CONSTANTS.RESULT_CLEARED,
          comments: historyComment || null,
          state: plcState || null,
          timestamp: new Date(),
          version: updatedIo.version,
        },
      })

      // Attempt immediate sync
      try {
        const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
        const synced = await getCloudSyncService().syncIoUpdate({
          id: ioId,
          result: TEST_CONSTANTS.RESULT_CLEARED,
          comments: historyComment || null,
          testedBy: currentUser || null,
          state: plcState || null,
          version: Number(updatedIo.version),
          timestamp: new Date().toISOString(),
        })
        if (synced) {
          await prisma.pendingSync.delete({ where: { id: pendingSync.id } }).catch(() => {})
        }
      } catch {
        // Immediate sync failed — PendingSync stays in queue for auto-sync retry
      }
    } catch (syncError) {
      console.error('[Reset] Failed to create PendingSync:', syncError)
    }

    console.log(`Test result cleared for IO ${ioId} by ${currentUser}`)

    return NextResponse.json({
      success: true,
      message: 'IO result cleared',
      io: {
        id: updatedIo.id,
        subsystemId: updatedIo.subsystemId,
        name: updatedIo.name,
        description: updatedIo.description,
        result: updatedIo.result,
        timestamp: updatedIo.timestamp,
        comments: updatedIo.comments,
        order: updatedIo.order,
        version: updatedIo.version.toString(),
        state: plcState ?? null
      },
      testHistory: {
        id: testHistory.id,
        ioId: testHistory.ioId,
        result: testHistory.result,
        timestamp: testHistory.timestamp,
        testedBy: testHistory.testedBy
      }
    })
  } catch (error) {
    console.error('Error resetting IO:', error)
    return NextResponse.json(
      { error: 'Failed to reset IO' },
      { status: 500 }
    )
  }
}
