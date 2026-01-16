import { NextResponse } from 'next/server'
import { getBackendUrl } from '@/lib/api-config'

const C_SHARP_BASE_URL = getBackendUrl()

// GET /api/configurations - List all configurations
export async function GET() {
  try {
    const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store'
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch configurations' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Error fetching configurations:', error)
    return NextResponse.json(
      { error: 'Failed to connect to C# backend' },
      { status: 500 }
    )
  }
}

// POST /api/configurations - Create new configuration
export async function POST(request: Request) {
  try {
    const body = await request.json()
    
    const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json(
        { error: errorText || 'Failed to create configuration' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data, { status: 201 })
  } catch (error) {
    console.error('Error creating configuration:', error)
    return NextResponse.json(
      { error: 'Failed to connect to C# backend' },
      { status: 500 }
    )
  }
}

