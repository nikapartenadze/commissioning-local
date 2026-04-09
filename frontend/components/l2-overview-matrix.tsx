"use client"

import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface MatrixCell {
  completed: number
  total: number
  percent: number
  lastTester: string | null
  lastTestedAt: string | null
}

interface OverviewData {
  hasData: boolean
  sheets: { name: string; displayName: string }[]
  mcms: string[]
  matrix: Record<string, Record<string, MatrixCell>>
  sheetTotals: Record<string, { completed: number; total: number; percent: number }>
  mcmTotals: Record<string, { completed: number; total: number; percent: number }>
  grandTotal: { completed: number; total: number; percent: number }
}

function percentColor(pct: number): string {
  if (pct === 0) return 'bg-muted text-muted-foreground'
  if (pct < 25) return 'bg-red-500/20 text-red-700 dark:text-red-300'
  if (pct < 50) return 'bg-orange-500/20 text-orange-700 dark:text-orange-300'
  if (pct < 75) return 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300'
  if (pct < 100) return 'bg-blue-500/20 text-blue-700 dark:text-blue-300'
  return 'bg-green-500/20 text-green-700 dark:text-green-300'
}

function percentBg(pct: number): string {
  if (pct === 0) return 'transparent'
  if (pct < 25) return 'hsl(0 70% 50% / 0.15)'
  if (pct < 50) return 'hsl(25 80% 50% / 0.15)'
  if (pct < 75) return 'hsl(45 80% 50% / 0.15)'
  if (pct < 100) return 'hsl(210 70% 50% / 0.15)'
  return 'hsl(140 60% 40% / 0.2)'
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function L2OverviewMatrix() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const res = await authFetch('/api/l2/overview')
      if (res.ok) {
        setData(await res.json())
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handleRefresh = () => {
    setRefreshing(true)
    fetchData()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading overview...
      </div>
    )
  }

  if (!data?.hasData) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No L2 data. Pull from cloud first.
      </div>
    )
  }

  const { sheets, mcms, matrix, sheetTotals, mcmTotals, grandTotal } = data

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <div>
          <h3 className="text-sm font-semibold">L2 Functional Validation — Overview</h3>
          <p className="text-[11px] text-muted-foreground">
            {grandTotal.completed}/{grandTotal.total} checks ({grandTotal.percent}%)
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={cn("h-3 w-3 mr-1", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Scrollable matrix */}
      <div className="flex-1 overflow-auto p-3">
        <table className="border-collapse text-xs w-full">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 bg-muted px-3 py-2 text-left font-bold border border-border min-w-[60px]">
                Type
              </th>
              <th className="sticky left-[60px] z-20 bg-muted px-3 py-2 text-left font-bold border border-border min-w-[140px]">
                Description
              </th>
              {mcms.map(mcm => (
                <th key={mcm} className="bg-muted px-2 py-2 text-center font-bold border border-border min-w-[70px] whitespace-nowrap">
                  {mcm}
                </th>
              ))}
              <th className="bg-muted/80 px-3 py-2 text-center font-bold border border-border min-w-[70px]">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {sheets.map(sheet => {
              const row = matrix[sheet.name] || {}
              const rowTotal = sheetTotals[sheet.name] || { completed: 0, total: 0, percent: 0 }
              return (
                <tr key={sheet.name} className="hover:bg-muted/30">
                  <td className="sticky left-0 z-10 bg-card px-3 py-1.5 font-mono font-bold border border-border whitespace-nowrap">
                    {sheet.name}
                  </td>
                  <td className="sticky left-[60px] z-10 bg-card px-3 py-1.5 border border-border truncate text-muted-foreground">
                    {sheet.displayName !== sheet.name ? sheet.displayName : ''}
                  </td>
                  {mcms.map(mcm => {
                    const cell = row[mcm]
                    if (!cell || cell.total === 0) {
                      return (
                        <td key={mcm} className="px-1 py-1 border border-border text-center text-muted-foreground/40">
                          —
                        </td>
                      )
                    }
                    return (
                      <td
                        key={mcm}
                        className={cn("px-1 py-1 border border-border text-center font-medium", percentColor(cell.percent))}
                        title={[
                          `${sheet.name} × ${mcm}`,
                          `${cell.completed}/${cell.total} (${cell.percent}%)`,
                          cell.lastTester ? `Last: ${cell.lastTester}` : null,
                          cell.lastTestedAt ? `Date: ${formatDate(cell.lastTestedAt)}` : null,
                        ].filter(Boolean).join('\n')}
                      >
                        <div className="tabular-nums">{cell.percent}%</div>
                        {cell.lastTester && (
                          <div className="text-[9px] opacity-60 truncate max-w-[60px] mx-auto">
                            {cell.lastTester.split(' ').map(w => w[0]).join('')}
                          </div>
                        )}
                      </td>
                    )
                  })}
                  <td className={cn("px-2 py-1.5 border border-border text-center font-bold", percentColor(rowTotal.percent))}>
                    {rowTotal.total > 0 ? `${rowTotal.percent}%` : '—'}
                  </td>
                </tr>
              )
            })}
            {/* MCM totals row */}
            <tr className="bg-muted/50 font-bold">
              <td className="sticky left-0 z-10 bg-muted px-3 py-2 border border-border" colSpan={2}>
                Total
              </td>
              {mcms.map(mcm => {
                const t = mcmTotals[mcm]
                return (
                  <td key={mcm} className={cn("px-2 py-2 border border-border text-center", percentColor(t.percent))}>
                    {t.total > 0 ? `${t.percent}%` : '—'}
                  </td>
                )
              })}
              <td className={cn("px-2 py-2 border border-border text-center", percentColor(grandTotal.percent))}>
                {grandTotal.percent}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="px-3 py-2 border-t shrink-0 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-500/20 border" /> 0-24%</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-500/20 border" /> 25-49%</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-500/20 border" /> 50-74%</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-500/20 border" /> 75-99%</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-500/20 border" /> 100%</span>
        <span className="ml-2">Hover cells for tester info</span>
      </div>
    </div>
  )
}
