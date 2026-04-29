import { Wifi, WifiOff, AlertOctagon, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SyncPillState } from '@/lib/belt-tracking/types'

interface Props {
  state: SyncPillState
}

/**
 * Header status pill — uses shadcn theme tokens so it follows
 * the global light/dark choice automatically.
 */
export function SyncStatusPill({ state }: Props) {
  const base = 'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-mono font-medium border whitespace-nowrap'

  if (state.kind === 'online') {
    return (
      <div
        className={cn(base, 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-900')}
        aria-label="Online — all synced"
      >
        <Wifi size={12} />
        <span>All synced</span>
      </div>
    )
  }
  if (state.kind === 'syncing') {
    return (
      <div
        className={cn(base, 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900')}
        aria-label={`Syncing ${state.pending} items`}
      >
        <Loader2 size={12} className="animate-spin" />
        <span>Syncing {state.pending}</span>
      </div>
    )
  }
  if (state.kind === 'offline_pending') {
    return (
      <div
        className={cn(base, 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900')}
        aria-label={`Offline — ${state.pending} pending`}
      >
        <WifiOff size={12} />
        <span>Offline · {state.pending} pending</span>
      </div>
    )
  }
  return (
    <div
      className={cn(base, 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900')}
      aria-label="Server unreachable"
    >
      <AlertOctagon size={12} />
      <span>Server unreachable</span>
    </div>
  )
}
