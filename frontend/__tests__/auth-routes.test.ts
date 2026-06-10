/**
 * Auth enforcement is OPT-IN via the AUTH_REQUIRED env var.
 *
 * These tests pin both modes of the verifyAuth / requireAuth / requireAdmin
 * contract used by the Express middleware (routes/middleware.ts):
 *
 *  - AUTH OFF (default): every request is treated as an anonymous ADMIN. This
 *    is the single-laptop / dev regression guardrail — endpoints stay open and
 *    no token is needed.
 *  - AUTH ON: a valid Bearer token is required (401 otherwise); a tester token
 *    is rejected by the admin guard (403) but accepted by the plain auth guard;
 *    an admin token passes both.
 *
 * Requests are modeled as plain Express-shaped objects ({ headers }) since
 * verifyAuth reads the Authorization header from either Express or Fetch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  verifyAuth,
  requireAuth,
  requireAdmin,
  getAuthUser,
  isAuthRequired,
} from '@/lib/auth/middleware'
import { generateToken } from '@/lib/auth/jwt'

process.env.JWT_SECRET_KEY = 'test-secret-key-for-automated-tests'

function reqWithToken(token?: string): any {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }
}

function adminToken(): string {
  return generateToken({ id: 1, fullName: 'Admin', isAdmin: true })
}

function testerToken(): string {
  return generateToken({ id: 2, fullName: 'Tester', isAdmin: false })
}

describe('AUTH_REQUIRED off (default / single-laptop / dev)', () => {
  beforeEach(() => {
    delete process.env.AUTH_REQUIRED
  })

  it('isAuthRequired() is false', () => {
    expect(isAuthRequired()).toBe(false)
  })

  it('verifyAuth succeeds with NO token (anonymous admin)', () => {
    const result = verifyAuth(reqWithToken())
    expect(result.success).toBe(true)
    expect(result.user?.isAdmin).toBe(true)
    expect(result.user?.fullName).toBe('Anonymous')
  })

  it('requireAuth passes (returns null) without a token', () => {
    expect(requireAuth(reqWithToken())).toBeNull()
  })

  it('requireAdmin passes (returns null) without a token — everyone is admin', () => {
    expect(requireAdmin(reqWithToken())).toBeNull()
  })

  it('treats AUTH_REQUIRED=0 / false / off as OFF', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      process.env.AUTH_REQUIRED = v
      expect(isAuthRequired()).toBe(false)
      expect(verifyAuth(reqWithToken()).success).toBe(true)
    }
  })
})

describe('AUTH_REQUIRED on (centralized server)', () => {
  beforeEach(() => {
    process.env.AUTH_REQUIRED = '1'
  })
  afterEach(() => {
    delete process.env.AUTH_REQUIRED
  })

  it('isAuthRequired() is true', () => {
    expect(isAuthRequired()).toBe(true)
  })

  it('verifyAuth 401s without a token', () => {
    const result = verifyAuth(reqWithToken())
    expect(result.success).toBe(false)
    expect(result.status).toBe(401)
  })

  it('verifyAuth 401s with an invalid/garbage token', () => {
    const result = verifyAuth(reqWithToken('not-a-real-token'))
    expect(result.success).toBe(false)
    expect(result.status).toBe(401)
  })

  it('verifyAuth 401s with an expired token', async () => {
    const jwt = await import('jsonwebtoken')
    const expired = jwt.default.sign(
      { sub: '1', fullName: 'X', isAdmin: true },
      process.env.JWT_SECRET_KEY!,
      { issuer: 'commissioning-tool', audience: 'commissioning-tool-frontend', expiresIn: '-1s' }
    )
    const result = verifyAuth(reqWithToken(expired))
    expect(result.success).toBe(false)
    expect(result.status).toBe(401)
  })

  it('accepts a valid admin token and exposes its claims', () => {
    const result = verifyAuth(reqWithToken(adminToken()))
    expect(result.success).toBe(true)
    expect(result.user?.isAdmin).toBe(true)
    expect(result.user?.fullName).toBe('Admin')
    expect(getAuthUser(reqWithToken(adminToken()))?.isAdmin).toBe(true)
  })

  it('accepts a valid tester token (auth guard) but it is NOT admin', () => {
    const result = verifyAuth(reqWithToken(testerToken()))
    expect(result.success).toBe(true)
    expect(result.user?.isAdmin).toBe(false)
  })

  describe('admin guard (config endpoints)', () => {
    it('rejects no token with 401', () => {
      const r = requireAdmin(reqWithToken())
      expect(r?.status).toBe(401)
    })

    it('rejects a tester token with 403', () => {
      const r = requireAdmin(reqWithToken(testerToken()))
      expect(r?.success).toBe(false)
      expect(r?.status).toBe(403)
    })

    it('allows an admin token (returns null)', () => {
      expect(requireAdmin(reqWithToken(adminToken()))).toBeNull()
    })
  })

  describe('auth guard (connect / test endpoints)', () => {
    it('rejects no token with 401', () => {
      expect(requireAuth(reqWithToken())?.status).toBe(401)
    })

    it('allows a tester token (returns null) — testers may connect/test', () => {
      expect(requireAuth(reqWithToken(testerToken()))).toBeNull()
    })

    it('allows an admin token (returns null)', () => {
      expect(requireAuth(reqWithToken(adminToken()))).toBeNull()
    })
  })

  it('reads the Authorization header from a Fetch-style request too', () => {
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${adminToken()}`)
    const result = verifyAuth({ headers })
    expect(result.success).toBe(true)
    expect(result.user?.isAdmin).toBe(true)
  })
})

describe('GET /api/auth/mode reflects the flag', () => {
  afterEach(() => {
    delete process.env.AUTH_REQUIRED
  })

  it('returns { required: false } when AUTH_REQUIRED is unset', async () => {
    delete process.env.AUTH_REQUIRED
    const { GET } = await import('@/app/api/auth/mode/route')
    let payload: any
    const res: any = { json: (b: any) => { payload = b; return res } }
    await GET({} as any, res)
    expect(payload).toEqual({ required: false })
  })

  it('returns { required: true } when AUTH_REQUIRED is set', async () => {
    process.env.AUTH_REQUIRED = '1'
    const { GET } = await import('@/app/api/auth/mode/route')
    let payload: any
    const res: any = { json: (b: any) => { payload = b; return res } }
    await GET({} as any, res)
    expect(payload).toEqual({ required: true })
  })
})
