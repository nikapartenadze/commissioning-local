import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth/middleware';

export async function GET(request: NextRequest) {
  const result = verifyAuth(request);

  if (!result.success) {
    return NextResponse.json(
      { message: result.error },
      { status: result.status || 401 }
    );
  }

  const user = result.user!;

  return NextResponse.json({
    id: user.sub,
    fullName: user.fullName,
    isAdmin: user.isAdmin,
    exp: user.exp,
    iat: user.iat,
  });
}
