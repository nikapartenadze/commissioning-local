'use client'

import { WifiOff } from "lucide-react"

export function ConnectionLostOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 pointer-events-none"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-red-500/60 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-900 shadow-md dark:bg-red-950/80 dark:text-red-100">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span>Connection lost — reconnecting</span>
        <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
      </div>
    </div>
  )
}
