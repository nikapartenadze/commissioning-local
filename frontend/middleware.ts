import { NextResponse } from 'next/server'

// Auth disabled — open access mode. All requests pass through.
export function middleware() {
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
