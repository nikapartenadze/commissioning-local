'use client'

import { Loader2 } from 'lucide-react'

/**
 * Non-modal "connection is slow" banner. Shown for the intermediate state
 * where the WS is still open but heartbeat acks are late — typically the
 * Node event loop is briefly stalled by a sync DB write, GC pause, or
 * disk activity. Used to be a full-screen modal, which was overkill for
 * a transient blip; this stays out of the way and clears on the next ack.
 */
export function ConnectionSlowBanner({
  visible,
  lastAckAgeSec,
}: {
  visible: boolean
  lastAckAgeSec: number
}) {
  if (!visible) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-300 bg-amber-50/95 dark:border-amber-700 dark:bg-amber-950/90 shadow-lg backdrop-blur-sm pointer-events-auto">
        <Loader2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 animate-spin" />
        <span className="text-xs font-medium text-amber-900 dark:text-amber-100">
          Connection slow
        </span>
        <span className="text-[11px] text-amber-700 dark:text-amber-400">
          (server hasn't responded for {lastAckAgeSec}s)
        </span>
      </div>
    </div>
  )
}
