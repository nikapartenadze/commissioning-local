import { NextResponse } from 'next/server'

const C_SHARP_BASE_URL = process.env.NEXT_PUBLIC_CSHARP_API_URL || 'http://localhost:5000'

// GET /api/configurations/:id - Get specific configuration
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store'
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Configuration not found' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Error fetching configuration:', error)
    return NextResponse.json(
      { error: 'Failed to connect to C# backend' },
      { status: 500 }
    )
  }
}

// PUT /api/configurations/:id - Update configuration
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json()
    
    const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json(
        { error: errorText || 'Failed to update configuration' },
        { status: response.status }
      )
    }

    return new Response(null, { status: 204 })
  } catch (error) {
    console.error('Error updating configuration:', error)
    return NextResponse.json(
      { error: 'Failed to connect to C# backend' },
      { status: 500 }
    )
  }
}

// DELETE /api/configurations/:id - Delete configuration
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const response = await fetch(`${C_SHARP_BASE_URL}/api/configuration/${params.id}`, {
      method: 'DELETE'
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json(
        { error: errorText || 'Failed to delete configuration' },
        { status: response.status }
      )
    }

    return new Response(null, { status: 204 })
  } catch (error) {
    console.error('Error deleting configuration:', error)
    return NextResponse.json(
      { error: 'Failed to connect to C# backend' },
      { status: 500 }
    )
  }
}

