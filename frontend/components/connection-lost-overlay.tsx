'use client'

export function ConnectionLostOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-card border-2 border-red-500 rounded-xl shadow-2xl p-8 max-w-sm mx-4 text-center space-y-4">
        <div className="w-16 h-16 mx-auto rounded-full border-4 border-red-500 flex items-center justify-center animate-pulse">
          <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728M5.636 18.364a9 9 0 010-12.728M12 9v4m0 4h.01" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-foreground">Connection Lost</h2>
        <p className="text-sm text-muted-foreground">
          Lost connection to the server. Waiting to reconnect...
        </p>
        <div className="flex items-center justify-center gap-2">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-xs text-muted-foreground">Reconnecting</span>
        </div>
      </div>
    </div>
  )
}
