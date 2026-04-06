'use client'

export function ConnectionLostOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] bg-red-600 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3 animate-in slide-in-from-top-2">
      <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
      <span className="text-sm font-medium">Connection lost — reconnecting...</span>
    </div>
  )
}
