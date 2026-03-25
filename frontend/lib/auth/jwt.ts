import jwt, { JwtPayload, SignOptions, VerifyOptions } from 'jsonwebtoken';

export interface UserTokenPayload {
  sub: string;
  fullName: string;
  isAdmin: boolean;
}

export interface DecodedToken extends JwtPayload {
  sub: string;
  fullName: string;
  isAdmin: boolean;
  jti?: string;
}

// --- Token revocation blacklist (in-memory, resets on server restart) ---

interface TokenEntry {
  userId: string;
  expiresAt: number; // unix ms
}

const _getTokenStore = (): Map<string, TokenEntry> => {
  const g = globalThis as any;
  if (!g.__tokenStore) g.__tokenStore = new Map<string, TokenEntry>();
  return g.__tokenStore;
};

const _getRevokedSet = (): Set<string> => {
  const g = globalThis as any;
  if (!g.__revokedTokens) g.__revokedTokens = new Set<string>();
  return g.__revokedTokens;
};

let _checkCount = 0;

/** Track a token so it can be revoked later by userId */
export function trackToken(jti: string, userId: string, expiresInMs: number): void {
  _getTokenStore().set(jti, { userId, expiresAt: Date.now() + expiresInMs });
}

/** Revoke all active tokens for a given user */
export function revokeTokensForUser(userId: string): void {
  const store = _getTokenStore();
  const revoked = _getRevokedSet();
  const now = Date.now();
  store.forEach((entry, jti) => {
    if (entry.userId === userId && entry.expiresAt > now) {
      revoked.add(jti);
    }
  });
}

/** Check if a token JTI has been revoked */
function isTokenRevoked(jti: string | undefined): boolean {
  if (!jti) return false;

  // Periodic cleanup every 100 checks
  _checkCount++;
  if (_checkCount >= 100) {
    _checkCount = 0;
    _cleanupExpired();
  }

  return _getRevokedSet().has(jti);
}

function _cleanupExpired(): void {
  const store = _getTokenStore();
  const revoked = _getRevokedSet();
  const now = Date.now();
  const expired: string[] = [];
  store.forEach((entry, jti) => {
    if (entry.expiresAt <= now) expired.push(jti);
  });
  expired.forEach(jti => { store.delete(jti); revoked.delete(jti); });
}

// ---

let _cachedSecret: string | null = null;

const getOrCreateSecret = (): string => {
  if (_cachedSecret) return _cachedSecret;

  const envSecret = process.env.JWT_SECRET_KEY;
  if (envSecret && envSecret !== 'change-this-to-a-random-secret') {
    _cachedSecret = envSecret;
    return envSecret;
  }

  // Auto-generate a persistent secret on first use
  const fs = require('fs');
  const path = require('path');
  const secretFile = path.join(process.cwd(), '.jwt-secret');

  try {
    if (fs.existsSync(secretFile)) {
      _cachedSecret = fs.readFileSync(secretFile, 'utf8').trim();
      return _cachedSecret!;
    }
  } catch {}

  // Generate and persist
  const newSecret = crypto.randomUUID() + '-' + crypto.randomUUID();
  try {
    fs.writeFileSync(secretFile, newSecret, 'utf8');
    console.log('[Auth] Generated new JWT secret (saved to .jwt-secret)');
  } catch {
    console.warn('[Auth] Could not persist JWT secret to file — tokens will invalidate on restart');
  }
  _cachedSecret = newSecret;
  return newSecret;
};

const getJwtConfig = () => {
  return {
    secretKey: getOrCreateSecret(),
    issuer: process.env.JWT_ISSUER || 'io-checkout-tool',
    audience: process.env.JWT_AUDIENCE || 'io-checkout-frontend',
    expirationHours: parseInt(process.env.JWT_EXPIRATION_HOURS || '8', 10),
  };
};

/**
 * Generate a JWT token for a user
 */
export function generateToken(user: {
  id: number;
  fullName: string;
  isAdmin: boolean;
}): string {
  const config = getJwtConfig();

  const payload = {
    sub: user.id.toString(),
    fullName: user.fullName,
    isAdmin: user.isAdmin,
    jti: crypto.randomUUID(),
  };

  const options: SignOptions = {
    algorithm: 'HS256',
    issuer: config.issuer,
    audience: config.audience,
    expiresIn: `${config.expirationHours}h`,
  };

  const token = jwt.sign(payload, config.secretKey, options);
  trackToken(payload.jti, user.id.toString(), config.expirationHours * 3600 * 1000);
  return token;
}

/**
 * Verify and decode a JWT token
 * Returns the decoded payload if valid, null if invalid
 */
export function verifyToken(token: string): DecodedToken | null {
  try {
    const config = getJwtConfig();

    const options: VerifyOptions = {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
    };

    const decoded = jwt.verify(token, config.secretKey, options) as DecodedToken;
    if (isTokenRevoked(decoded.jti)) {
      return null;
    }
    return decoded;
  } catch (error) {
    if (error instanceof Error && error.message.includes('JWT_SECRET_KEY')) {
      console.error('[Auth] JWT_SECRET_KEY not configured — cannot verify tokens');
    }
    // Token is invalid, expired, or has wrong signature
    return null;
  }
}

/**
 * Decode a token without verification (useful for debugging)
 * WARNING: Do not use this for authentication - always use verifyToken
 */
export function decodeToken(token: string): DecodedToken | null {
  try {
    const decoded = jwt.decode(token) as DecodedToken | null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Extract token from Authorization header
 * Expects format: "Bearer <token>"
 */
export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}
