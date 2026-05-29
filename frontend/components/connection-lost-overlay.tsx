'use client'

import { WifiOff } from "lucide-react"

/**
 * Full-screen, interaction-blocking overlay shown when the browser loses its
 * heartbeat to the LOCAL FRONTEND web server (not the PLC, not the cloud).
 *
 * Why it blocks everything: all authoritative local-tool state lives on the
 * frontend server (SQLite). Once the browser↔frontend link is down, none of
 * the operator's clicks would take effect — so we stop them from trying and
 * make it unmistakable that the page is unusable until connectivity returns.
 * Mirrors the old Blazor app's "disconnected" modal.
 *
 * It auto-dismisses: the parent only renders this while `visible` is true, and
 * the heartbeat flips back to healthy (hiding it) the moment the socket
 * reconnects. A server-version change across the gap triggers a full reload
 * (handled in the WS client), so the operator lands on fresh assets.
 *
 * `fixed inset-0` + a high z-index + NO `pointer-events-none` means every
 * click/tap lands on this backdrop and is swallowed.
 */
export function ConnectionLostOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-live="assertive"
      aria-label="Connection to the commissioning tool lost"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm"
      // Belt-and-suspenders: swallow any interaction that reaches the backdrop.
      onClickCapture={(e) => { e.preventDefault(); e.stopPropagation() }}
      onKeyDownCapture={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      <div className="mx-4 max-w-md rounded-xl border-2 border-red-500/60 bg-card p-6 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/15">
          <WifiOff className="h-7 w-7 text-red-500 animate-pulse" />
        </div>
        <h2 className="text-lg font-bold text-foreground">Connection lost</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page can't reach the commissioning tool right now. Your actions
          won't be saved until the connection is restored.
        </p>
        <p className="mt-3 text-sm font-medium text-foreground">
          Trying to reconnect…
        </p>
        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
          <span>This screen will clear itself once you're back online.</span>
        </div>
      </div>
    </div>
  )
}
