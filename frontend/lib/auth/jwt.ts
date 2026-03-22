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

const getJwtConfig = () => {
  const secretKey = process.env.JWT_SECRET_KEY;
  if (!secretKey) {
    throw new Error('JWT_SECRET_KEY environment variable is not configured');
  }

  return {
    secretKey,
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

  return jwt.sign(payload, config.secretKey, options);
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
