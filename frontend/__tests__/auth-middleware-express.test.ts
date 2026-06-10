/**
 * Express middleware layer (routes/middleware.ts) end-to-end across both
 * AUTH_REQUIRED modes. This is the layer the route table actually mounts, so it
 * exercises the real authMiddleware / adminMiddleware → verifyAuth chain
 * including the 401/403 responses and req.user attachment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { authMiddleware, adminMiddleware } from '@/routes/middleware'
import { generateToken } from '@/lib/auth/jwt'

process.env.JWT_SECRET_KEY = 'test-secret-key-for-automated-tests'

function makeReq(token?: string): any {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} }
}

function makeRes(): any {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this },
    json(payload: any) { this.body = payload; return this },
  }
  return res
}

const adminToken = () => generateToken({ id: 1, fullName: 'Admin', isAdmin: true })
const testerToken = () => generateToken({ id: 2, fullName: 'Tester', isAdmin: false })

describe('Express auth middleware — AUTH OFF (regression guard)', () => {
  beforeEach(() => { delete process.env.AUTH_REQUIRED })

  it('authMiddleware calls next() and attaches anon admin without a token', () => {
    const req = makeReq()
    const res = makeRes()
    const next = vi.fn()
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.user?.isAdmin).toBe(true)
  })

  it('adminMiddleware calls next() without a token (everyone is admin)', () => {
    const res = makeRes()
    const next = vi.fn()
    adminMiddleware(makeReq(), res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('Express auth middleware — AUTH ON', () => {
  beforeEach(() => { process.env.AUTH_REQUIRED = '1' })
  afterEach(() => { delete process.env.AUTH_REQUIRED })

  it('authMiddleware → 401 with no token', () => {
    const res = makeRes()
    const next = vi.fn()
    authMiddleware(makeReq(), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it('authMiddleware → next() with a tester token (testers may connect/test)', () => {
    const req = makeReq(testerToken())
    const res = makeRes()
    const next = vi.fn()
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.user?.isAdmin).toBe(false)
  })

  it('adminMiddleware → 403 with a tester token (config endpoint)', () => {
    const res = makeRes()
    const next = vi.fn()
    adminMiddleware(makeReq(testerToken()), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })

  it('adminMiddleware → 401 with no token', () => {
    const res = makeRes()
    const next = vi.fn()
    adminMiddleware(makeReq(), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  it('adminMiddleware → next() with an admin token', () => {
    const req = makeReq(adminToken())
    const res = makeRes()
    const next = vi.fn()
    adminMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.user?.isAdmin).toBe(true)
  })
})

describe('Express auth middleware — must-change-PIN gate (AUTH ON)', () => {
  beforeEach(() => { process.env.AUTH_REQUIRED = '1' })
  afterEach(() => { delete process.env.AUTH_REQUIRED })

  const mustChangeToken = () =>
    generateToken({ id: 1, fullName: 'Admin', isAdmin: true, mustChangePin: true })

  function makeReqPath(token: string, path: string): any {
    return { headers: { authorization: `Bearer ${token}` }, path }
  }

  it('refuses a normal route (403 must-change-pin) while the PIN is unchanged', () => {
    const res = makeRes()
    const next = vi.fn()
    authMiddleware(makeReqPath(mustChangeToken(), '/api/mcm'), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    expect(res.body?.code).toBe('must-change-pin')
  })

  it('blocks even admin config routes until the PIN is changed', () => {
    const res = makeRes()
    const next = vi.fn()
    adminMiddleware(makeReqPath(mustChangeToken(), '/api/mcm/cloud-config'), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
  })

  it('allows the change-PIN endpoint through', () => {
    const req = makeReqPath(mustChangeToken(), '/api/auth/change-pin')
    const res = makeRes()
    const next = vi.fn()
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.user?.mustChangePin).toBe(true)
  })

  it('a normal token (no flag) is unaffected by the gate', () => {
    const req = makeReqPath(adminToken(), '/api/mcm')
    const res = makeRes()
    const next = vi.fn()
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
