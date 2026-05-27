import { cn } from '@/lib/utils'
import type { RingStatusUpdateMessage } from '@/lib/plc/types'

/**
 * DLR ring-health badge. Reflects the Rockwell DLR ring as reported by the
 * EN4TR ring supervisor (CIP DLR Object, read-only). Gray "Unknown" until the
 * poller confirms a ring — never shows Healthy unless Topology=Ring AND
 * Network Status=Normal. Shared by the Network page header and the Diagnostics
 * panel so both surfaces show the one authoritative verdict.
 */
export function RingHealthBadge({ ring }: { ring: RingStatusUpdateMessage['ring'] | null }) {
  const state = ring?.state ?? 'unknown'
  const style =
    state === 'healthy'
      ? { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Healthy' }
      : state === 'degraded'
        ? { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'Degraded' }
        : { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground', label: 'Unknown' }
  const facts =
    ring && ring.state !== 'unknown'
      ? [
          `Topology ${ring.topology === 1 ? 'Ring' : 'Linear'}`,
          ring.faultCount != null ? `Faults ${ring.faultCount}` : null,
          ring.participants != null ? `${ring.participants} nodes` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : ring?.reason ?? 'No ring reading yet'
  return (
    <div className="shrink-0 flex flex-col items-end gap-0.5" title={facts}>
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold uppercase tracking-wide">
        <span className={cn('w-2 h-2 rounded-full', style.dot)} />
        <span className="text-muted-foreground/80">DLR Ring</span>
        <span className={style.text}>{style.label}</span>
      </span>
      {state === 'degraded' && ring?.reason && (
        <span className="text-[9px] text-red-600/80 dark:text-red-400/80 max-w-[240px] truncate">
          {ring.reason}
          {ring.lastActiveNode1 || ring.lastActiveNode2
            ? ` · between ${ring.lastActiveNode1 ?? '?'} and ${ring.lastActiveNode2 ?? '?'}`
            : ''}
        </span>
      )}
    </div>
  )
}
