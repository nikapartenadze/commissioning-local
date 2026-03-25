import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth/middleware'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authError = requireAuth(request)
  if (authError) return authError

  try {
    const { searchParams } = new URL(request.url)
    const subsystemId = searchParams.get('subsystemId')

    if (!subsystemId) {
      return NextResponse.json({ error: 'subsystemId is required' }, { status: 400 })
    }

    const subId = parseInt(subsystemId, 10)

    const subsystem = await prisma.subsystem.findUnique({
      where: { id: subId },
      include: { project: { select: { name: true } } },
    })

    const ios = await prisma.io.findMany({
      where: { subsystemId: subId },
      orderBy: { order: 'asc' },
    })

    const failedIos = ios.filter(io => io.result === 'Fail')

    // Get latest test history for failed IOs
    const failedHistories = failedIos.length > 0
      ? await prisma.testHistory.findMany({
          where: {
            ioId: { in: failedIos.map(io => io.id) },
            result: 'Fail',
          },
          orderBy: { timestamp: 'desc' },
        })
      : []

    // Map ioId -> latest failure info
    const failureMap = new Map<number, { failureMode: string | null; testedBy: string | null }>()
    for (const h of failedHistories) {
      if (!failureMap.has(h.ioId)) {
        failureMap.set(h.ioId, { failureMode: h.failureMode, testedBy: h.testedBy })
      }
    }

    const totalIos = ios.length
    const passed = ios.filter(io => io.result === 'Pass').length
    const failed = failedIos.length
    const notTested = ios.filter(io => !io.result).length
    const completionPct = totalIos > 0 ? (((passed + failed) / totalIos) * 100).toFixed(1) : '0.0'

    const projectName = subsystem?.project?.name || 'Unknown Project'
    const subsystemName = subsystem?.name || `Subsystem ${subId}`
    const reportDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })

    const esc = (s: string | null | undefined) => {
      if (!s) return ''
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

    const formatTs = (ts: string | null | undefined) => {
      if (!ts) return '—'
      try {
        return new Date(ts).toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      } catch { return ts }
    }

    const resultColor = (r: string | null) => {
      if (r === 'Pass') return 'color: #16a34a; font-weight: bold;'
      if (r === 'Fail') return 'color: #dc2626; font-weight: bold;'
      return 'color: #6b7280;'
    }

    const ioRows = ios.map(io => `
      <tr>
        <td>${esc(io.name)}</td>
        <td>${esc(io.description)}</td>
        <td style="${resultColor(io.result)}">${io.result || 'Not Tested'}</td>
        <td>${esc(io.tagType)}</td>
        <td>${formatTs(io.timestamp)}</td>
        <td>${esc(io.comments)}</td>
      </tr>
    `).join('')

    const failedRows = failedIos.map(io => {
      const info = failureMap.get(io.id)
      return `
        <tr>
          <td>${esc(io.name)}</td>
          <td>${esc(io.description)}</td>
          <td>${esc(info?.failureMode) || '—'}</td>
          <td>${esc(info?.testedBy) || '—'}</td>
          <td>${esc(io.comments)}</td>
        </tr>
      `
    }).join('')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Commissioning Report — ${esc(projectName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; padding: 40px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin: 32px 0 12px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
  .meta { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
  .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 32px; }
  .summary-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; text-align: center; }
  .summary-card .value { font-size: 28px; font-weight: 700; }
  .summary-card .label { font-size: 12px; color: #6b7280; text-transform: uppercase; margin-top: 4px; }
  .pass { color: #16a34a; }
  .fail { color: #dc2626; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
  th { background: #f3f4f6; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  tr:nth-child(even) { background: #f9fafb; }
  .sign-off { margin-top: 48px; page-break-inside: avoid; }
  .sign-line { display: flex; align-items: flex-end; gap: 12px; margin: 28px 0; }
  .sign-line .label { font-weight: 600; min-width: 120px; }
  .sign-line .line { flex: 1; border-bottom: 1px solid #1a1a1a; min-width: 200px; }
  .sign-line .date-line { width: 180px; border-bottom: 1px solid #1a1a1a; }
  .no-print { margin-bottom: 24px; }
  .no-print button { padding: 10px 24px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 15px; cursor: pointer; margin-right: 8px; }
  .no-print button:hover { background: #1d4ed8; }

  @media print {
    body { padding: 0; }
    .no-print { display: none !important; }
    h2 { page-break-after: avoid; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
    .sign-off { page-break-before: always; }
  }
</style>
</head>
<body>

<div class="no-print">
  <button onclick="window.print()">Print / Save as PDF</button>
</div>

<h1>Commissioning Report</h1>
<p class="meta">${esc(projectName)} — ${esc(subsystemName)}<br>Generated: ${esc(reportDate)}</p>

<h2>Summary</h2>
<div class="summary">
  <div class="summary-card"><div class="value">${totalIos}</div><div class="label">Total IOs</div></div>
  <div class="summary-card"><div class="value pass">${passed}</div><div class="label">Passed</div></div>
  <div class="summary-card"><div class="value fail">${failed}</div><div class="label">Failed</div></div>
  <div class="summary-card"><div class="value">${notTested}</div><div class="label">Not Tested</div></div>
  <div class="summary-card"><div class="value">${completionPct}%</div><div class="label">Completion</div></div>
</div>

<h2>IO Results</h2>
<table>
  <thead>
    <tr><th>IO Name</th><th>Description</th><th>Result</th><th>Tag Type</th><th>Timestamp</th><th>Comments</th></tr>
  </thead>
  <tbody>${ioRows}</tbody>
</table>

${failedIos.length > 0 ? `
<h2>Failed IOs — Detail</h2>
<table>
  <thead>
    <tr><th>IO Name</th><th>Description</th><th>Failure Reason</th><th>Tested By</th><th>Comments</th></tr>
  </thead>
  <tbody>${failedRows}</tbody>
</table>
` : ''}

<div class="sign-off">
  <h2>Sign-Off</h2>
  <div class="sign-line"><span class="label">Technician:</span><span class="line"></span><span class="label">Date:</span><span class="date-line"></span></div>
  <div class="sign-line"><span class="label">Supervisor:</span><span class="line"></span><span class="label">Date:</span><span class="date-line"></span></div>
  <div class="sign-line"><span class="label">Project Manager:</span><span class="line"></span><span class="label">Date:</span><span class="date-line"></span></div>
</div>

</body>
</html>`

    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    console.error('Failed to generate report:', error)
    return NextResponse.json({ error: 'Failed to generate report' }, { status: 500 })
  }
}
