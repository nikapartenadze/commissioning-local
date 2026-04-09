import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { TEST_CONSTANTS } from '@/lib/services/io-test-service'

// Prepared statements — created once at module load, reused on every request
const stmts = {
  totalBySub: db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ?'),
  passedBySub: db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result = ?'),
  failedBySub: db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result = ?'),
  totalAll: db.prepare('SELECT COUNT(*) as count FROM Ios'),
  passedAll: db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result = ?'),
  failedAll: db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result = ?'),
}

export async function GET(req: Request, res: Response) {
  try {
    const subsystemIdParam = req.query.subsystemId as string | undefined
    const subsystemId = subsystemIdParam ? parseInt(subsystemIdParam) : undefined

    let total: number, passed: number, failed: number

    if (subsystemId) {
      total = (stmts.totalBySub.get(subsystemId) as { count: number }).count
      passed = (stmts.passedBySub.get(subsystemId, TEST_CONSTANTS.RESULT_PASSED) as { count: number }).count
      failed = (stmts.failedBySub.get(subsystemId, TEST_CONSTANTS.RESULT_FAILED) as { count: number }).count
    } else {
      total = (stmts.totalAll.get() as { count: number }).count
      passed = (stmts.passedAll.get(TEST_CONSTANTS.RESULT_PASSED) as { count: number }).count
      failed = (stmts.failedAll.get(TEST_CONSTANTS.RESULT_FAILED) as { count: number }).count
    }

    const untested = total - passed - failed

    const passedPercent = total > 0 ? Math.round((passed / total) * 100) : 0
    const failedPercent = total > 0 ? Math.round((failed / total) * 100) : 0
    const untestedPercent = total > 0 ? Math.round((untested / total) * 100) : 0

    return res.json({
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
    return res.status(500).json({ error: 'Failed to fetch IO statistics' })
  }
}
