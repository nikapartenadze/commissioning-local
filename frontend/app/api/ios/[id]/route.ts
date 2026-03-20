export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getPlcTags } from '@/lib/plc-client-manager'
import { sanitizeComment, createTimestamp } from '@/lib/services/io-test-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/ios/[id]
 * Get single IO by ID with current PLC state
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { id } = await params
    const ioId = parseInt(id)

    if (isNaN(ioId)) {
      return NextResponse.json({ error: 'Invalid IO ID' }, { status: 400 })
    }

    const io = await prisma.io.findUnique({
      where: { id: ioId }
    })

    if (!io) {
      return NextResponse.json({ error: 'IO not found' }, { status: 404 })
    }

    // Get current PLC state
    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)

    const ioWithState = {
      id: io.id,
      subsystemId: io.subsystemId,
      name: io.name,
      description: io.description,
      result: io.result,
      timestamp: io.timestamp,
      comments: io.comments,
      order: io.order,
      version: io.version.toString(),
      state: tag?.state ?? null,
      isOutput: io.name?.includes(':O.') || io.name?.includes(':SO.') || io.name?.includes('.O.') || io.name?.includes(':O:') || io.name?.includes('.Outputs.') || io.name?.endsWith('.DO'),
      hasResult: !!io.result,
      isPassed: io.result === 'Passed',
      isFailed: io.result === 'Failed'
    }

    return NextResponse.json(ioWithState)
  } catch (error) {
    console.error('Error fetching IO:', error)
    return NextResponse.json(
      { error: 'Failed to fetch IO' },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/ios/[id]
 * Update IO result and/or comments
 */
export async function PUT(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { id } = await params
    const ioId = parseInt(id)

    if (isNaN(ioId)) {
      return NextResponse.json({ error: 'Invalid IO ID' }, { status: 400 })
    }

    const body = await request.json()
    const { result, comments, currentUser } = body

    // Validate comment length
    if (comments && comments.length > 500) {
      return NextResponse.json(
        { error: 'Comment must be 500 characters or fewer' },
        { status: 400 }
      )
    }

    const io = await prisma.io.findUnique({
      where: { id: ioId }
    })

    if (!io) {
      return NextResponse.json({ error: 'IO not found' }, { status: 404 })
    }

    // Get current PLC state
    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)
    const plcState = tag?.state

    const sanitizedComments = sanitizeComment(comments)
    const timestamp = createTimestamp()

    // Update IO and create history in transaction
    const [updatedIo] = await prisma.$transaction([
      prisma.io.update({
        where: { id: ioId },
        data: {
          result: result !== undefined ? result : io.result,
          comments: sanitizedComments !== undefined ? sanitizedComments : io.comments,
          timestamp,
          version: { increment: 1 }
        }
      }),
      prisma.testHistory.create({
        data: {
          ioId,
          result: result ?? io.result ?? 'Updated',
          timestamp,
          comments: io.comments, // Store old comment
          state: plcState,
          testedBy: currentUser ?? 'Unknown'
        }
      })
    ])

    // Queue for cloud sync + attempt immediate sync
    try {
      const pendingSync = await prisma.pendingSync.create({
        data: {
          ioId,
          inspectorName: currentUser || null,
          testResult: updatedIo.result || null,
          comments: (sanitizedComments !== undefined ? sanitizedComments : io.comments) || null,
          state: plcState || null,
          timestamp: new Date(),
          version: updatedIo.version,
        },
      })

      try {
        const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
        const synced = await getCloudSyncService().syncIoUpdate({
          id: ioId,
          result: updatedIo.result || null,
          comments: (sanitizedComments !== undefined ? sanitizedComments : io.comments) || null,
          testedBy: currentUser || null,
          state: plcState || null,
          version: Number(updatedIo.version),
          timestamp: new Date().toISOString(),
        })
        if (synced) {
          await prisma.pendingSync.delete({ where: { id: pendingSync.id } }).catch(() => {})
        }
      } catch {
        // Immediate sync failed — PendingSync stays in queue
      }
    } catch (syncError) {
      console.error('[IO Update] Failed to create PendingSync:', syncError)
    }

    return NextResponse.json({
      success: true,
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
      }
    })
  } catch (error) {
    console.error('Error updating IO:', error)
    return NextResponse.json(
      { error: 'Failed to update IO' },
      { status: 500 }
    )
  }
}
