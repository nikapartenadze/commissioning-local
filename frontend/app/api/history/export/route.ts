import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export const dynamic = 'force-dynamic'

interface HistoryExportRow {
  id: number;
  IoId: number;
  Result: string | null;
  TestedBy: string | null;
  Timestamp: string | null;
  FailureMode: string | null;
  State: string | null;
  Comments: string | null;
  IoName: string | null;
  IoDescription: string | null;
  TagType: string | null;
  NetworkDeviceName: string | null;
  SubsystemName: string | null;
}

/**
 * GET /api/history/export?format=csv&from=<date>&to=<date>&subsystemId=<id>&result=<result>
 * Export test history as CSV with optional filters.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const subsystemId = searchParams.get('subsystemId')
    const result = searchParams.get('result')
    const testedBy = searchParams.get('testedBy')

    // Build WHERE clause dynamically
    const conditions: string[] = []
    const params: unknown[] = []

    if (from) {
      conditions.push('th.Timestamp >= ?')
      params.push(new Date(from).toISOString())
    }
    if (to) {
      conditions.push('th.Timestamp <= ?')
      params.push(new Date(to).toISOString())
    }
    if (result) {
      conditions.push('th.Result = ?')
      params.push(result)
    }
    if (testedBy) {
      conditions.push('th.TestedBy = ?')
      params.push(testedBy)
    }
    if (subsystemId) {
      conditions.push('i.SubsystemId = ?')
      params.push(parseInt(subsystemId, 10))
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = db.prepare(`
      SELECT th.*,
             i.Name as IoName,
             i.Description as IoDescription,
             i.TagType,
             i.NetworkDeviceName,
             s.Name as SubsystemName
      FROM TestHistories th
      LEFT JOIN Ios i ON th.IoId = i.id
      LEFT JOIN Subsystems s ON i.SubsystemId = s.id
      ${whereClause}
      ORDER BY th.Timestamp DESC
    `).all(...params) as HistoryExportRow[]

    // Build CSV
    const headers = [
      'Date/Time',
      'IO Name',
      'Description',
      'Tag Type',
      'Network Device',
      'Subsystem',
      'Result',
      'Failure Mode',
      'State',
      'Comments',
      'Tested By',
    ]

    const escapeCSV = (val: string | null | undefined): string => {
      if (!val) return ''
      const str = String(val)
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
      }
      return str
    }

    const csvRows = rows.map(h => [
      h.Timestamp ? new Date(h.Timestamp).toLocaleString() : '',
      h.IoName ?? '',
      h.IoDescription ?? '',
      h.TagType ?? '',
      h.NetworkDeviceName ?? '',
      h.SubsystemName ?? '',
      h.Result ?? '',
      h.FailureMode ?? '',
      h.State ?? '',
      h.Comments ?? '',
      h.TestedBy ?? '',
    ].map(escapeCSV).join(','))

    const csv = [headers.join(','), ...csvRows].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="test-history-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (error) {
    console.error('Failed to export test history:', error)
    return NextResponse.json(
      { error: 'Failed to export test history' },
      { status: 500 }
    )
  }
}
