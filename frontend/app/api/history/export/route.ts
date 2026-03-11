import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

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

    // Build where clause
    const where: Record<string, unknown> = {}

    if (from || to) {
      where.timestamp = {}
      if (from) (where.timestamp as Record<string, string>).gte = new Date(from).toISOString()
      if (to) (where.timestamp as Record<string, string>).lte = new Date(to).toISOString()
    }

    if (result) where.result = result
    if (testedBy) where.testedBy = testedBy

    // Subsystem filter goes through the IO relation
    if (subsystemId) {
      where.io = { subsystemId: parseInt(subsystemId, 10) }
    }

    const history = await prisma.testHistory.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      include: {
        io: {
          select: {
            name: true,
            description: true,
            tagType: true,
            networkDeviceName: true,
            subsystem: {
              select: { name: true },
            },
          },
        },
      },
    })

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

    const rows = history.map(h => [
      h.timestamp ? new Date(h.timestamp).toLocaleString() : '',
      h.io?.name ?? '',
      h.io?.description ?? '',
      h.io?.tagType ?? '',
      h.io?.networkDeviceName ?? '',
      h.io?.subsystem?.name ?? '',
      h.result ?? '',
      h.failureMode ?? '',
      h.state ?? '',
      h.comments ?? '',
      h.testedBy ?? '',
    ].map(escapeCSV).join(','))

    const csv = [headers.join(','), ...rows].join('\n')

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
