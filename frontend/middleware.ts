import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_PATHS = ['/', '/api/auth/login', '/api/auth/verify', '/api/health']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow static assets, auth endpoints, and health
  if (PUBLIC_PATHS.some(p => pathname === p) || pathname.startsWith('/_next/') || pathname.startsWith('/guide/')) {
    return NextResponse.next()
  }

  // API routes handle their own auth via requireAuth/withAuth
  if (pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  // For page routes, check for auth token in localStorage-synced cookie or header
  // Client stores token in localStorage; we check if user has been authenticated
  // by looking for the token cookie that the client can set
  const token = request.cookies.get('authToken')?.value
    || request.headers.get('authorization')?.replace('Bearer ', '')

  if (!token) {
    // Redirect unauthenticated page requests to login
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
