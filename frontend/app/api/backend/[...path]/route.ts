import { NextRequest, NextResponse } from 'next/server'

/**
 * Backend Proxy Route
 *
 * This catch-all route forwards all requests from the browser to the C# backend.
 * This eliminates CORS issues because:
 * 1. Browser only talks to Next.js (same origin)
 * 2. Next.js server talks to backend (server-to-server, no CORS)
 *
 * Route mapping:
 * /api/backend/status → http://localhost:5000/api/status
 * /api/backend/ios → http://localhost:5000/api/ios
 * /api/backend/ios/123/pass → http://localhost:5000/api/ios/123/pass
 * etc.
 */

// Backend URL: configurable via BACKEND_URL env var (for Docker), defaults to localhost:5000
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000'

async function proxyRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const resolvedParams = await params
  const path = resolvedParams.path.join('/')
  const backendUrl = `${BACKEND_URL}/api/${path}`

  // Get query string
  const { searchParams } = new URL(request.url)
  const queryString = searchParams.toString()
  const fullUrl = queryString ? `${backendUrl}?${queryString}` : backendUrl

  console.log(`[Proxy] ${request.method} ${fullUrl}`)

  try {
    // Prepare headers - forward relevant headers
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    }

    // Forward authorization if present
    const authHeader = request.headers.get('Authorization')
    if (authHeader) {
      headers['Authorization'] = authHeader
    }

    // Build fetch options
    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
    }

    // Forward body for POST, PUT, PATCH
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      try {
        const body = await request.text()
        if (body) {
          fetchOptions.body = body
        }
      } catch {
        // No body or empty body
      }
    }

    // Make request to backend
    const response = await fetch(fullUrl, fetchOptions)

    // Get response data
    const responseText = await response.text()

    // Create response with same status
    const proxyResponse = new NextResponse(responseText || null, {
      status: response.status,
      statusText: response.statusText,
    })

    // Copy content-type header
    const contentType = response.headers.get('content-type')
    if (contentType) {
      proxyResponse.headers.set('Content-Type', contentType)
    }

    return proxyResponse

  } catch (error) {
    console.error(`[Proxy] Error forwarding to ${fullUrl}:`, error)
    return NextResponse.json(
      {
        error: 'Backend connection failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        backendUrl: fullUrl
      },
      { status: 502 }
    )
  }
}

// Handle all HTTP methods
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, context)
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, context)
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, context)
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, context)
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, context)
}
