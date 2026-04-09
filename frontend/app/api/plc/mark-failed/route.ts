import { Request, Response } from 'express'
import { markTestFailedAsync } from '@/lib/services/io-test-service'
import { getAuthUser } from '@/lib/auth/middleware'

export async function POST(req: Request, res: Response) {
  try {
    const { ioId, comments, failureMode } = req.body

    const authUser = await getAuthUser(req as any)
    const currentUser = authUser?.fullName ?? 'Unknown'

    const result = await markTestFailedAsync(ioId, {
      currentUser,
      comments,
      failureMode,
    })

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error })
    }

    return res.json({
      success: true,
      message: `Test marked as failed for IO ${ioId}`,
    })
  } catch (error) {
    console.error('Failed to mark test as failed:', error)
    return res.status(500).json({ success: false, error: 'Failed to mark test as failed' })
  }
}
