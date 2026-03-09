import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    // Get all active users (users who have logged in)
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
