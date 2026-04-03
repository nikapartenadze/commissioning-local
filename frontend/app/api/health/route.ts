import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    // Check database connectivity
    db.prepare('SELECT 1').get()

    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected'
    })
  } catch (error) {
    console.error('Health check failed:', error)
    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 503 }
    )
  }
}
