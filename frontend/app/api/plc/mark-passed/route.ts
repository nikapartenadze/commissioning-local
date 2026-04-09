import { Request, Response } from 'express'
import { markTestPassedAsync } from '@/lib/services/io-test-service'
import { getAuthUser } from '@/lib/auth/middleware'

export async function POST(req: Request, res: Response) {
  try {
    const { ioId } = req.body

    const authUser = await getAuthUser(req as any)
    const currentUser = authUser?.fullName ?? 'Unknown'

    const result = await markTestPassedAsync(ioId, { currentUser })

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error })
    }

    return res.json({
      success: true,
      message: `Test marked as passed for IO ${ioId}`,
    })
  } catch (error) {
    console.error('Failed to mark test as passed:', error)
    return res.status(500).json({ success: false, error: 'Failed to mark test as passed' })
  }
}
