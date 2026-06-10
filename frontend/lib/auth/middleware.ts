import { DecodedToken, verifyToken, extractTokenFromHeader } from './jwt';

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
 * Auth is OPT-IN, controlled by the AUTH_REQUIRED env var.
 *
 * - When AUTH_REQUIRED is NOT set (default / single-laptop / dev): open-access
 *   mode — always returns the anonymous ADMIN. This is the regression guardrail:
 *   the field tablet and the dev server behave exactly as before.
 * - When AUTH_REQUIRED is set (centralized installer): enforce — extract the
 *   Bearer token from the Authorization header and verify it. Missing/invalid
 *   tokens fail with a 401.
 *
 * The flag is read on every call (not cached) so tests can flip it per-case.
 */
export function isAuthRequired(): boolean {
  const v = process.env.AUTH_REQUIRED;
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'off' && s !== 'no';
}

/**
 * Extract the Authorization header from either an Express request
 * (req.headers.authorization) or a WHATWG Request (req.headers.get('authorization')).
 */
function readAuthHeader(request: any): string | null {
  if (!request) return null;
  const h = request.headers;
  if (!h) return null;
  // WHATWG Headers (Fetch Request)
  if (typeof h.get === 'function') {
    return h.get('authorization') || h.get('Authorization') || null;
  }
  // Express plain-object headers
  return (h.authorization || h.Authorization || null) as string | null;
}

/**
 * Verify auth for a request. Honors AUTH_REQUIRED.
 * The request object is accepted as `any` to work with both Express and legacy callers.
 */
export function verifyAuth(request: any): AuthResult {
  if (!isAuthRequired()) {
    return { success: true, user: ANONYMOUS_USER };
  }

  const token = extractTokenFromHeader(readAuthHeader(request));
  if (!token) {
    return { success: false, error: 'Missing authentication token', status: 401 };
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return { success: false, error: 'Invalid or expired token', status: 401 };
  }

  return { success: true, user: decoded };
}

/**
 * Returns null when the request is authenticated, or an AuthResult-shaped
 * error object (with .status) when it is not. Convenience guard.
 */
export function requireAuth(request: any): AuthResult | null {
  const result = verifyAuth(request);
  if (!result.success) return result;
  return null;
}

/**
 * Returns null when the request is an authenticated ADMIN, or an
 * AuthResult-shaped error (401 if unauthenticated, 403 if non-admin).
 */
export function requireAdmin(request: any): AuthResult | null {
  const result = verifyAuth(request);
  if (!result.success) return result;
  if (!result.user?.isAdmin) {
    return { success: false, error: 'Forbidden', status: 403 };
  }
  return null;
}

/** Returns the decoded user when valid, or null. */
export function getAuthUser(request: any): DecodedToken | null {
  const result = verifyAuth(request);
  return result.success ? result.user ?? null : null;
}

export type { DecodedToken };
