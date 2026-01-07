// Authentication disabled for testing purposes
// export { default } from "next-auth/middleware"

// export const config = {
//   matcher: [
//     /*
//      * Match all request paths except:
//      * - api/auth (authentication endpoints)
//      * - _next/static (static files)
//      * - _next/image (image optimization)
//      * - public folder
//      */
//     '/((?!api/auth|_next/static|_next/image|favicon.ico|auth/).*)',
//   ],
// }

// Dummy middleware function to satisfy Next.js requirements
import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  // No authentication - just pass through all requests
  return NextResponse.next()
}

export const config = {
  matcher: [
    // Match all paths - but do nothing (no authentication)
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}

