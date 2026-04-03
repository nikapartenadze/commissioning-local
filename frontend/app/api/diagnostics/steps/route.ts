import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export const dynamic = 'force-dynamic'

interface DiagnosticRow {
  TagType: string;
  FailureMode: string;
  DiagnosticSteps: string;
}

/**
 * GET /api/diagnostics/steps?tagType=<tagType>&failureMode=<failureMode>
 * Returns diagnostic steps (markdown) for a specific tag type + failure mode.
 * If only tagType provided, returns all diagnostics for that tag type.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const tagType = searchParams.get('tagType')
    const failureMode = searchParams.get('failureMode')

    if (!tagType) {
      return NextResponse.json(
        { error: 'tagType parameter is required' },
        { status: 400 }
      )
    }

    // Specific diagnostic for tagType + failureMode
    if (failureMode) {
      const diagnostic = db.prepare(
        'SELECT * FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
      ).get(tagType, failureMode) as DiagnosticRow | undefined

      if (!diagnostic) {
        return NextResponse.json(
          { error: 'No diagnostic steps found for this tag type and failure mode' },
          { status: 404 }
        )
      }

      return NextResponse.json({ steps: diagnostic.DiagnosticSteps })
    }

    // All diagnostics for this tag type
    const diagnostics = db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE TagType = ? ORDER BY FailureMode ASC'
    ).all(tagType) as DiagnosticRow[]

    if (diagnostics.length === 0) {
      return NextResponse.json(
        { error: 'No diagnostic steps found for this tag type' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      tagType,
      diagnostics: diagnostics.map(d => ({
        failureMode: d.FailureMode,
        steps: d.DiagnosticSteps,
      })),
    })
  } catch (error) {
    console.error('Failed to fetch diagnostic steps:', error)
    return NextResponse.json(
      { error: 'Failed to fetch diagnostic steps' },
      { status: 500 }
    )
  }
}
