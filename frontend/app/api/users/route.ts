import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withAdmin } from '@/lib/auth/middleware'
import { hashPin } from '@/lib/auth/password'

// GET /api/users — list all users (admin only)
export const GET = withAdmin(async () => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      fullName: true,
      isAdmin: true,
      isActive: true,
      createdAt: true,
      lastUsedAt: true,
    },
    orderBy: { fullName: 'asc' },
  })

  return NextResponse.json(users)
})

// POST /api/users — create a new user (admin only)
export const POST = withAdmin(async (request: NextRequest) => {
  const body = await request.json()
  const { fullName, pin } = body

  if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
    return NextResponse.json({ message: 'Full name is required' }, { status: 400 })
  }

  if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    return NextResponse.json({ message: 'PIN must be exactly 6 digits' }, { status: 400 })
  }

  // Check for duplicate name
  const existing = await prisma.user.findFirst({
    where: { fullName: fullName.trim() },
  })
  if (existing) {
    return NextResponse.json({ message: 'A user with this name already exists' }, { status: 409 })
  }

  const hashedPin = await hashPin(pin)

  const user = await prisma.user.create({
    data: {
      fullName: fullName.trim(),
      pin: hashedPin,
      isAdmin: false,
      isActive: true,
      createdAt: new Date().toISOString(),
    },
    select: {
      id: true,
      fullName: true,
      isAdmin: true,
      isActive: true,
      createdAt: true,
    },
  })

  return NextResponse.json(user, { status: 201 })
})
