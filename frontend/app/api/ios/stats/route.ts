import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TEST_CONSTANTS } from '@/lib/services/io-test-service'

/**
 * GET /api/ios/stats
 * Return test statistics (total, passed, failed, untested)
 *
 * Query params:
 * - subsystemId (optional): Filter by subsystem
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const subsystemIdParam = searchParams.get('subsystemId')
    const subsystemId = subsystemIdParam ? parseInt(subsystemIdParam) : undefined

    // Build where clause
    const where = subsystemId ? { subsystemId } : {}

    // Get counts in parallel
    const [total, passed, failed] = await Promise.all([
      prisma.io.count({ where }),
      prisma.io.count({
        where: { ...where, result: TEST_CONSTANTS.RESULT_PASSED }
      }),
      prisma.io.count({
        where: { ...where, result: TEST_CONSTANTS.RESULT_FAILED }
      })
    ])

    const untested = total - passed - failed

    // Calculate percentages
    const passedPercent = total > 0 ? Math.round((passed / total) * 100) : 0
    const failedPercent = total > 0 ? Math.round((failed / total) * 100) : 0
    const untestedPercent = total > 0 ? Math.round((untested / total) * 100) : 0

    return NextResponse.json({
      total,
      passed,
      failed,
      untested,
      passedPercent,
      failedPercent,
      untestedPercent,
      subsystemId: subsystemId ?? null
    })
  } catch (error) {
    console.error('Error fetching IO stats:', error)
    return NextResponse.json(
      { error: 'Failed to fetch IO statistics' },
      { status: 500 }
    )
  }
}
