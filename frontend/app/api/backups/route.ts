import { NextRequest, NextResponse } from 'next/server'
import { listBackups, createBackup } from '@/lib/db/backup'

/**
 * GET /api/backups — List all backups
 */
export async function GET() {
  try {
    const backups = await listBackups()
    return NextResponse.json({ success: true, backups })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

/**
 * POST /api/backups — Create a manual backup
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const reason = body.reason || 'manual'
    const backup = await createBackup(reason)
    return NextResponse.json({ success: true, backup })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
