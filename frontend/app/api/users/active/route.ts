export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth } from '@/lib/auth/middleware'

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request)
  if (authError) return authError

  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        isAdmin: true,
        lastUsedAt: true,
      },
      orderBy: {
        lastUsedAt: 'desc',
      },
    })

    return NextResponse.json(users)
  } catch (error) {
    console.error('Failed to get active users:', error)
    return NextResponse.json([])
  }
}
