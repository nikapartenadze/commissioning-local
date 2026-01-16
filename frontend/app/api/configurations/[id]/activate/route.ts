import { NextResponse } from 'next/server'
import { getBackendUrl } from '@/lib/api-config'

const C_SHARP_BASE_URL = getBackendUrl()

// POST /api/configurations/:id/activate - Activate configuration (switch subsystem)
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json(
        { error: errorText || 'Failed to activate configuration' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Error activating configuration:', error)
    return NextResponse.json(
      { error: 'Failed to connect to C# backend. Make sure the C# app is running on port 5000.' },
      { status: 500 }
    )
  }
}

