import { NextRequest, NextResponse } from 'next/server'
import { markTestFailedAsync } from '@/lib/services/io-test-service'
import { getAuthUser } from '@/lib/auth/middleware'

export async function POST(request: NextRequest) {
  try {
    const { ioId, comments, failureMode } = await request.json()

    const authUser = await getAuthUser(request)
    const currentUser = authUser?.fullName ?? 'Unknown'

    const result = await markTestFailedAsync(ioId, {
      currentUser,
      comments,
      failureMode,
    })

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      message: `Test marked as failed for IO ${ioId}`,
    })
  } catch (error) {
    console.error('Failed to mark test as failed:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to mark test as failed' },
      { status: 500 }
    )
  }
}
