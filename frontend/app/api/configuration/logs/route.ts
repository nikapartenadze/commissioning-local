export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { getConfigLogs, clearConfigLogs } from '@/lib/config/config-log'

/**
 * GET /api/configuration/logs
 *
 * Returns log entries after the specified ID.
 * Query params:
 *   - afterId: number (default 0) - only return logs with id > afterId
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const afterId = parseInt(searchParams.get('afterId') || '0', 10)

  const result = getConfigLogs(afterId)
  return NextResponse.json(result)
}

/**
 * DELETE /api/configuration/logs
 *
 * Clears the log buffer.
 */
export async function DELETE() {
  clearConfigLogs()
  return NextResponse.json({ success: true })
}
