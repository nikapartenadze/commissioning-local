import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  ready: number
  tracked: number
  notReady: number
}

const COLORS = {
  tracked: '#10b981',   // emerald-500
  ready: '#f59e0b',     // amber-500
  notReady: '#94a3b8',  // slate-400
}

/**
 * Belt-tracking progress chart. Three segments:
 *  - Tracked      (emerald)
 *  - Ready        (amber)
 *  - Not Ready    (slate)
 *
 * Recharts is already a project dependency (used elsewhere). The chart
 * is rendered in a modal so it doesn't compete with the main spreadsheet
 * for screen real estate — mechanics open it for an at-a-glance check.
 */
export function ProgressChartDialog({ open, onOpenChange, ready, tracked, notReady }: Props) {
  const total = ready + tracked + notReady
  const data = [
    { name: 'Tracked',   value: tracked,  color: COLORS.tracked },
    { name: 'Ready',     value: ready,    color: COLORS.ready },
    { name: 'Not Ready', value: notReady, color: COLORS.notReady },
  ].filter(d => d.value > 0)

  const trackedPct = total > 0 ? Math.round((tracked / total) * 100) : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">Belt Tracking Progress</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {total} VFDs · {trackedPct}% tracked
          </DialogDescription>
        </DialogHeader>

        {total === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No VFDs to chart yet.
          </div>
        ) : (
          <>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                    stroke="hsl(var(--background))"
                    strokeWidth={3}
                  >
                    {data.map((d) => (
                      <Cell key={d.name} fill={d.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      `${value} (${total > 0 ? Math.round((value / total) * 100) : 0}%)`,
                      name,
                    ]}
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      color: 'hsl(var(--popover-foreground))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '6px',
                      fontSize: '12px',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Legend with raw counts */}
            <div className="space-y-2">
              <LegendRow color={COLORS.tracked}  label="Tracked"   value={tracked}  total={total} />
              <LegendRow color={COLORS.ready}    label="Ready"     value={ready}    total={total} />
              <LegendRow color={COLORS.notReady} label="Not Ready" value={notReady} total={total} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function LegendRow({ color, label, value, total }: { color: string; label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: color }} />
      <span className="flex-1 font-medium">{label}</span>
      <span className="font-mono tabular-nums text-muted-foreground">{pct}%</span>
      <span className="font-mono tabular-nums font-semibold w-10 text-right">{value}</span>
    </div>
  )
}
