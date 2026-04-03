import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

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
      const rows = db.prepare(
        'SELECT FailureMode FROM TagTypeDiagnostics WHERE TagType = ? ORDER BY FailureMode ASC'
      ).all(tagType) as { FailureMode: string }[]
      return NextResponse.json(rows.map(d => d.FailureMode))
    }

    // No tagType — return all distinct failure modes
    const rows = db.prepare(
      'SELECT DISTINCT FailureMode FROM TagTypeDiagnostics ORDER BY FailureMode ASC'
    ).all() as { FailureMode: string }[]
    return NextResponse.json(rows.map(d => d.FailureMode))
  } catch (error) {
    console.error('Failed to fetch failure modes:', error)
    return NextResponse.json(
      { error: 'Failed to fetch failure modes' },
      { status: 500 }
    )
  }
}
