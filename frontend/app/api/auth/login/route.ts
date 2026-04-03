export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
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

export async function POST(request: NextRequest) {
  try {
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || 'unknown';

    const rateLimit = checkRateLimit(clientIp);

    if (!rateLimit.allowed) {
      const retryAfter = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
      return NextResponse.json(
        { message: 'Too many login attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': retryAfter.toString(),
            'X-RateLimit-Limit': RATE_LIMIT_MAX_ATTEMPTS.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': Math.ceil(rateLimit.resetAt / 1000).toString(),
          },
        }
      );
    }

    let body: LoginRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { message: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { fullName, pin } = body;

    if (!pin?.trim()) {
      return NextResponse.json(
        { message: 'PIN is required' },
        { status: 400 }
      );
    }

    // Ensure default data exists on first login attempt
    await userRepository.ensureDefaultAdmin();
    await ensureDiagnosticData();

    let user: { id: number; fullName: string; isAdmin: boolean; isActive: boolean; pin: string } | undefined;

    if (fullName?.trim()) {
      // Named login: find by fullName and verify PIN
      const row = db.prepare('SELECT * FROM Users WHERE FullName = ?').get(fullName.trim()) as UserRow | undefined;

      if (!row || !row.IsActive) {
        return NextResponse.json(
          { message: 'Invalid credentials' },
          { status: 401 }
        );
      }

      const pinValid = await verifyPin(pin, row.Pin);
      if (!pinValid) {
        return NextResponse.json(
          { message: 'Invalid PIN' },
          { status: 401 }
        );
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
        return NextResponse.json(
          { message: 'Invalid PIN' },
          { status: 401 }
        );
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

    return NextResponse.json(
      {
        fullName: user.fullName,
        isAdmin: user.isAdmin,
        loginTime: new Date().toISOString().replace('T', ' ').substring(0, 19),
        token,
      },
      {
        status: 200,
        headers: {
          'X-RateLimit-Limit': RATE_LIMIT_MAX_ATTEMPTS.toString(),
          'X-RateLimit-Remaining': rateLimit.remaining.toString(),
          'X-RateLimit-Reset': Math.ceil(rateLimit.resetAt / 1000).toString(),
        },
      }
    );
  } catch (error) {
    console.error('Error during login:', error);
    return NextResponse.json(
      { message: 'An error occurred during login' },
      { status: 500 }
    );
  }
}
