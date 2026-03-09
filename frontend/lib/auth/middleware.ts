import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractTokenFromHeader, DecodedToken } from './jwt';

export interface AuthenticatedRequest extends NextRequest {
  user?: DecodedToken;
}

export interface AuthResult {
  success: boolean;
  user?: DecodedToken;
  error?: string;
  status?: number;
}

/**
 * Verify JWT from Authorization header
 * Returns the decoded user if valid, error info otherwise
 */
export function verifyAuth(request: NextRequest): AuthResult {
  const authHeader = request.headers.get('authorization');
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    return {
      success: false,
      error: 'Authorization header missing or invalid',
      status: 401,
    };
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    return {
      success: false,
      error: 'Invalid or expired token',
      status: 401,
    };
  }

  return {
    success: true,
    user: decoded,
  };
}

/**
 * Middleware helper to protect API routes
 * Returns a response with error if auth fails, undefined if auth succeeds
 */
export function requireAuth(request: NextRequest): NextResponse | null {
  const result = verifyAuth(request);

  if (!result.success) {
    return NextResponse.json(
      { message: result.error },
      { status: result.status || 401 }
    );
  }

  return null;
}

/**
 * Middleware helper to require admin access
 * Returns a response with error if auth fails or user is not admin
 */
export function requireAdmin(request: NextRequest): NextResponse | null {
  const result = verifyAuth(request);

  if (!result.success) {
    return NextResponse.json(
      { message: result.error },
      { status: result.status || 401 }
    );
  }

  if (!result.user?.isAdmin) {
    return NextResponse.json(
      { message: 'Admin access required' },
      { status: 403 }
    );
  }

  return null;
}

/**
 * Get authenticated user from request
 * Returns the user if auth succeeds, null otherwise
 */
export function getAuthUser(request: NextRequest): DecodedToken | null {
  const result = verifyAuth(request);
  return result.success ? result.user! : null;
}

/**
 * Higher-order function to wrap route handlers with authentication
 *
 * Usage:
 * export const GET = withAuth(async (request, user) => {
 *   // user is guaranteed to be authenticated
 *   return NextResponse.json({ data: 'protected data' });
 * });
 */
export function withAuth(
  handler: (request: NextRequest, user: DecodedToken) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const result = verifyAuth(request);

    if (!result.success) {
      return NextResponse.json(
        { message: result.error },
        { status: result.status || 401 }
      );
    }

    return handler(request, result.user!);
  };
}

/**
 * Higher-order function to wrap route handlers with admin authentication
 *
 * Usage:
 * export const POST = withAdmin(async (request, user) => {
 *   // user is guaranteed to be an admin
 *   return NextResponse.json({ data: 'admin only data' });
 * });
 */
export function withAdmin(
  handler: (request: NextRequest, user: DecodedToken) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const result = verifyAuth(request);

    if (!result.success) {
      return NextResponse.json(
        { message: result.error },
        { status: result.status || 401 }
      );
    }

    if (!result.user?.isAdmin) {
      return NextResponse.json(
        { message: 'Admin access required' },
        { status: 403 }
      );
    }

    return handler(request, result.user);
  };
}
