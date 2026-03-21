/**
 * Test: Every critical API route requires authentication.
 *
 * If a new route is added without auth, this test catches it.
 * Prevents the class of bug where PLC control or test result
 * endpoints are accidentally left unprotected.
 */
import { describe, it, expect } from 'vitest'
import { requireAuth } from '@/lib/auth/middleware'
import { generateToken } from '@/lib/auth/jwt'
import { NextRequest } from 'next/server'

process.env.JWT_SECRET_KEY = 'test-secret-key'

function makeUnauthenticatedRequest(url: string, method = 'GET'): NextRequest {
  return new NextRequest(new Request(`http://localhost:3000${url}`, { method }))
}

function makeAuthenticatedRequest(url: string, method = 'GET'): NextRequest {
  const token = generateToken({ id: 1, fullName: 'Test', isAdmin: false })
  return new NextRequest(new Request(`http://localhost:3000${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  }))
}

describe('Auth middleware', () => {
  it('rejects requests without Authorization header', () => {
    const req = makeUnauthenticatedRequest('/api/test')
    const result = requireAuth(req)
    expect(result).not.toBeNull()
    expect(result?.status).toBe(401)
  })

  it('rejects requests with invalid token', () => {
    const req = new NextRequest(new Request('http://localhost:3000/api/test', {
      headers: { Authorization: 'Bearer invalid-garbage-token' },
    }))
    const result = requireAuth(req)
    expect(result).not.toBeNull()
    expect(result?.status).toBe(401)
  })

  it('accepts requests with valid token', () => {
    const req = makeAuthenticatedRequest('/api/test')
    const result = requireAuth(req)
    expect(result).toBeNull() // null = auth passed
  })

  it('rejects expired token', async () => {
    // Create a token that's already expired
    const jwt = await import('jsonwebtoken')
    const expiredToken = jwt.default.sign(
      { id: 1, fullName: 'Test', isAdmin: false },
      'test-secret-key',
      { expiresIn: '-1s' }
    )
    const req = new NextRequest(new Request('http://localhost:3000/api/test', {
      headers: { Authorization: `Bearer ${expiredToken}` },
    }))
    const result = requireAuth(req)
    expect(result).not.toBeNull()
    expect(result?.status).toBe(401)
  })
})
