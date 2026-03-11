import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

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
      const diagnostic = await prisma.tagTypeDiagnostic.findUnique({
        where: {
          tagType_failureMode: { tagType, failureMode },
        },
      })

      if (!diagnostic) {
        return NextResponse.json(
          { error: 'No diagnostic steps found for this tag type and failure mode' },
          { status: 404 }
        )
      }

      return NextResponse.json({ steps: diagnostic.diagnosticSteps })
    }

    // All diagnostics for this tag type
    const diagnostics = await prisma.tagTypeDiagnostic.findMany({
      where: { tagType },
      orderBy: { failureMode: 'asc' },
    })

    if (diagnostics.length === 0) {
      return NextResponse.json(
        { error: 'No diagnostic steps found for this tag type' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      tagType,
      diagnostics: diagnostics.map(d => ({
        failureMode: d.failureMode,
        steps: d.diagnosticSteps,
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
