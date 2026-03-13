import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getPlcTags } from '@/lib/plc-client-manager'

/**
 * GET /api/ios
 * Returns all IOs with current PLC state
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const subsystemId = searchParams.get('subsystemId')

    // Build query
    const where = subsystemId ? { subsystemId: parseInt(subsystemId) } : {}

    // Fetch IOs from database
    const ios = await prisma.io.findMany({
      where,
      orderBy: { order: 'asc' }
    })

    // Get current PLC states
    const { tags, count } = getPlcTags()
    console.log(`[IOs API] Got ${count} tags from PLC client`)
    const stateMap = new Map(tags.map(t => [t.id, t.state]))

    // Merge PLC states with IO data
    const iosWithState = ios.map(io => ({
      id: io.id,
      subsystemId: io.subsystemId,
      name: io.name,
      description: io.description,
      result: io.result,
      timestamp: io.timestamp,
      comments: io.comments,
      order: io.order,
      version: io.version.toString(), // BigInt to string for JSON serialization
      tagType: io.tagType,
      state: stateMap.get(io.id) ?? null,
      isOutput: io.name?.includes(':O.') || io.name?.includes(':SO.') || io.name?.includes('.O.') || io.name?.includes(':O:') || io.name?.includes('.Outputs.') || io.name?.endsWith('.DO'),
      hasResult: !!io.result,
      isPassed: io.result === 'Passed',
      isFailed: io.result === 'Failed'
    }))

    return NextResponse.json(iosWithState)
  } catch (error) {
    console.error('Error fetching IOs:', error)
    return NextResponse.json(
      { error: 'Failed to fetch IOs' },
      { status: 500 }
    )
  }
}
