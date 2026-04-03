export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
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

    let total: number, passed: number, failed: number

    if (subsystemId) {
      total = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ?').get(subsystemId) as { count: number }).count
      passed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result = ?').get(subsystemId, TEST_CONSTANTS.RESULT_PASSED) as { count: number }).count
      failed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result = ?').get(subsystemId, TEST_CONSTANTS.RESULT_FAILED) as { count: number }).count
    } else {
      total = (db.prepare('SELECT COUNT(*) as count FROM Ios').get() as { count: number }).count
      passed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result = ?').get(TEST_CONSTANTS.RESULT_PASSED) as { count: number }).count
      failed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result = ?').get(TEST_CONSTANTS.RESULT_FAILED) as { count: number }).count
    }

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
