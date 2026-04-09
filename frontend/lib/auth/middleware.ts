import { DecodedToken } from './jwt';

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
 * The request object is accepted as `any` to work with both Express and legacy callers.
 */
export function verifyAuth(_request: any): AuthResult {
  return {
    success: true,
    user: ANONYMOUS_USER,
  };
}

/** Auth disabled — always returns null (no error). */
export function requireAuth(_request: any): any | null {
  return null;
}

/** Auth disabled — always returns null (no error). */
export function requireAdmin(_request: any): any | null {
  return null;
}

/** Auth disabled — always returns the anonymous user. */
export function getAuthUser(_request: any): DecodedToken | null {
  return ANONYMOUS_USER;
}

export type { DecodedToken };
