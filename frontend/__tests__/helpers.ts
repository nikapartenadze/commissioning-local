/**
 * Test helpers — create auth tokens, mock requests, etc.
 */
import { generateToken } from '@/lib/auth/jwt'

// Set JWT secret for tests
process.env.JWT_SECRET_KEY = 'test-secret-key-for-automated-tests'

export function createTestToken(isAdmin = false): string {
  return generateToken({
    id: 1,
    fullName: isAdmin ? 'Test Admin' : 'Test User',
    isAdmin,
  })
}

export function createAuthHeaders(isAdmin = false): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${createTestToken(isAdmin)}`)
  headers.set('Content-Type', 'application/json')
  return headers
}

export function createMockRequest(
  url: string,
  options: {
    method?: string
    body?: any
    headers?: Headers
    authenticated?: boolean
    admin?: boolean
  } = {}
): Request {
  const { method = 'GET', body, authenticated = false, admin = false } = options
  const headers = options.headers || new Headers()

  if (authenticated && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${createTestToken(admin)}`)
  }
  headers.set('Content-Type', 'application/json')

  return new Request(`http://localhost:3000${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}
