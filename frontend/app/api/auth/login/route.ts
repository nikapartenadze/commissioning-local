import { Request, Response } from 'express'
import { generateToken } from '@/lib/auth/jwt';
import { verifyPin } from '@/lib/auth/password';
import { db } from '@/lib/db-sqlite';
import userRepository from '@/lib/db/repositories/user-repository';
import { ensureDiagnosticData } from '@/lib/db/seed-diagnostics';

// In-memory rate limiting store
interface RateLimitEntry {
  attempts: number;
  windowStart: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_ATTEMPTS = 5;

function checkRateLimit(identifier: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(identifier);

  // Clean up expired entries periodically
  if (rateLimitStore.size > 1000) {
    const entries = Array.from(rateLimitStore.entries());
    for (const [key, val] of entries) {
      if (now - val.windowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitStore.delete(key);
      }
    }
  }

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Start new window
    rateLimitStore.set(identifier, { attempts: 1, windowStart: now });
    return {
      allowed: true,
      remaining: RATE_LIMIT_MAX_ATTEMPTS - 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
  }

  if (entry.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: entry.windowStart + RATE_LIMIT_WINDOW_MS,
    };
  }

  // Increment attempts
  entry.attempts += 1;
  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX_ATTEMPTS - entry.attempts,
    resetAt: entry.windowStart + RATE_LIMIT_WINDOW_MS,
  };
}

interface LoginRequest {
  fullName?: string;
  pin: string;
}

interface UserRow {
  id: number;
  FullName: string;
  Pin: string;
  IsAdmin: number;
  IsActive: number;
  CreatedAt: string | null;
  LastUsedAt: string | null;
}

export async function POST(req: Request, res: Response) {
  try {
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.headers['x-real-ip'] as string
      || 'unknown';

    const rateLimit = checkRateLimit(clientIp);

    if (!rateLimit.allowed) {
      const retryAfter = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
      return res
        .status(429)
        .set({
          'Retry-After': retryAfter.toString(),
          'X-RateLimit-Limit': RATE_LIMIT_MAX_ATTEMPTS.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': Math.ceil(rateLimit.resetAt / 1000).toString(),
        })
        .json({ message: 'Too many login attempts. Please try again later.' });
    }

    const body: LoginRequest = req.body;

    if (!body || !body.pin) {
      return res.status(400).json({ message: 'Invalid request body' });
    }

    const { fullName, pin } = body;

    if (!pin?.trim()) {
      return res.status(400).json({ message: 'PIN is required' });
    }

    // Ensure default data exists on first login attempt
    await userRepository.ensureDefaultAdmin();
    await ensureDiagnosticData();

    let user: { id: number; fullName: string; isAdmin: boolean; isActive: boolean; pin: string } | undefined;

    if (fullName?.trim()) {
      // Named login: find by fullName and verify PIN
      const row = db.prepare('SELECT * FROM Users WHERE FullName = ?').get(fullName.trim()) as UserRow | undefined;

      if (!row || !row.IsActive) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const pinValid = await verifyPin(pin, row.Pin);
      if (!pinValid) {
        return res.status(401).json({ message: 'Invalid PIN' });
      }

      user = { id: row.id, fullName: row.FullName, isAdmin: !!row.IsAdmin, isActive: !!row.IsActive, pin: row.Pin };
    } else {
      // PIN-only login: iterate users server-side
      const activeUsers = db.prepare('SELECT * FROM Users WHERE IsActive = 1').all() as UserRow[];

      for (const candidate of activeUsers) {
        const isMatch = await verifyPin(pin, candidate.Pin);
        if (isMatch) {
          user = { id: candidate.id, fullName: candidate.FullName, isAdmin: !!candidate.IsAdmin, isActive: !!candidate.IsActive, pin: candidate.Pin };
          break;
        }
      }

      if (!user) {
        return res.status(401).json({ message: 'Invalid PIN' });
      }
    }

    // Update last used timestamp
    db.prepare('UPDATE Users SET LastUsedAt = ? WHERE id = ?').run(
      new Date().toISOString().replace('T', ' ').substring(0, 19),
      user.id
    );

    const token = generateToken({
      id: user.id,
      fullName: user.fullName,
      isAdmin: user.isAdmin,
    });

    console.info(`User logged in: ${user.fullName}`);

    return res
      .status(200)
      .set({
        'X-RateLimit-Limit': RATE_LIMIT_MAX_ATTEMPTS.toString(),
        'X-RateLimit-Remaining': rateLimit.remaining.toString(),
        'X-RateLimit-Reset': Math.ceil(rateLimit.resetAt / 1000).toString(),
      })
      .json({
        fullName: user.fullName,
        isAdmin: user.isAdmin,
        loginTime: new Date().toISOString().replace('T', ' ').substring(0, 19),
        token,
      });
  } catch (error) {
    console.error('Error during login:', error);
    return res.status(500).json({ message: 'An error occurred during login' });
  }
}
