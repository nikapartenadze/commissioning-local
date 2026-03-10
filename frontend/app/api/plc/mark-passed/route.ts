import { NextRequest, NextResponse } from 'next/server'
import { markTestPassedAsync } from '@/lib/services/io-test-service'
import { getAuthUser } from '@/lib/auth/middleware'

export async function POST(request: NextRequest) {
  try {
    const { ioId } = await request.json()

    const authUser = await getAuthUser(request)
    const currentUser = authUser?.fullName ?? 'Unknown'

    const result = await markTestPassedAsync(ioId, { currentUser })

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      message: `Test marked as passed for IO ${ioId}`,
    })
  } catch (error) {
    console.error('Failed to mark test as passed:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to mark test as passed' },
      { status: 500 }
    )
  }
}
