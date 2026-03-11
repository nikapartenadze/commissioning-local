import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/diagnostics/failure-modes?tagType=<tagType>
 * Returns array of failure mode strings for a given tag type.
 * If no tagType provided, returns all distinct failure modes.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const tagType = searchParams.get('tagType')

    if (tagType) {
      const diagnostics = await prisma.tagTypeDiagnostic.findMany({
        where: { tagType },
        select: { failureMode: true },
        orderBy: { failureMode: 'asc' },
      })
      return NextResponse.json(diagnostics.map(d => d.failureMode))
    }

    // No tagType — return all distinct failure modes
    const diagnostics = await prisma.tagTypeDiagnostic.findMany({
      select: { failureMode: true },
      distinct: ['failureMode'],
      orderBy: { failureMode: 'asc' },
    })
    return NextResponse.json(diagnostics.map(d => d.failureMode))
  } catch (error) {
    console.error('Failed to fetch failure modes:', error)
    return NextResponse.json(
      { error: 'Failed to fetch failure modes' },
      { status: 500 }
    )
  }
}
