import { NextRequest, NextResponse } from 'next/server';
import { DecodedToken } from './jwt';

export interface AuthenticatedRequest extends NextRequest {
  user?: DecodedToken;
}

export interface AuthResult {
  success: boolean;
  user?: DecodedToken;
  error?: string;
  status?: number;
}

// Default anonymous user for open-access mode
const ANONYMOUS_USER: DecodedToken = {
  sub: '0',
  fullName: 'Anonymous',
  isAdmin: true,
};

/**
 * Auth disabled — open access mode. Always returns success.
 */
export function verifyAuth(_request: NextRequest): AuthResult {
  return {
    success: true,
    user: ANONYMOUS_USER,
  };
}

/**
 * Auth disabled — always returns null (no error).
 */
export function requireAuth(_request: NextRequest): NextResponse | null {
  return null;
}

/**
 * Auth disabled — always returns null (no error).
 */
export function requireAdmin(_request: NextRequest): NextResponse | null {
  return null;
}

/**
 * Auth disabled — always returns the anonymous user.
 */
export function getAuthUser(_request: NextRequest): DecodedToken | null {
  return ANONYMOUS_USER;
}

/**
 * Auth disabled — passes through to handler with anonymous user.
 */
export function withAuth(
  handler: (request: NextRequest, user: DecodedToken) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    return handler(request, ANONYMOUS_USER);
  };
}

/**
 * Auth disabled — passes through to handler with anonymous admin user.
 */
export function withAdmin(
  handler: (request: NextRequest, user: DecodedToken) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    return handler(request, ANONYMOUS_USER);
  };
}
