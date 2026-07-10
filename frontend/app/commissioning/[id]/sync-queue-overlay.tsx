// Sync queue overlay — extracted verbatim from page.tsx. Self-contained: it
// takes everything (hasPending / summary / onOpenSync) via props and owns only
// its own debounce visibility state; it holds no dependency on the page's
// state, handlers, or refs.

import { useState, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/**
 * Sync queue overlay — fixed-position toast in bottom-right corner.
 * Debounced: only appears after 3s of continuous pending items,
 * so brief queue states during fast testing don't flicker the UI.
 */
export function SyncQueueOverlay({
  hasPending,
  summary,
  onOpenSync,
}: {
  hasPending: boolean
  summary: string
  onOpenSync: () => void
}) {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (hasPending) {
      // Show after 3s of continuous pending
      timerRef.current = setTimeout(() => setVisible(true), 3000)
    } else {
      // Hide immediately when queue clears
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
      setVisible(false)
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [hasPending])

  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 z-50 max-w-sm transition-all duration-300 ease-in-out",
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-4 pointer-events-none"
      )}
    >
      <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/90 shadow-lg px-4 py-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Syncing {summary}</p>
          <p className="text-xs text-amber-600 dark:text-amber-400">Pull blocked until complete</p>
        </div>
        <Button
          variant="outline" size="sm"
          className="shrink-0 h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
          onClick={onOpenSync}
        >
          Sync
        </Button>
      </div>
    </div>
  )
}
