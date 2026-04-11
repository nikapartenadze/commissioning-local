"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Zap } from "lucide-react"
import { authFetch } from "@/lib/api-config"

interface IoItem {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  state: string | null
  subsystemName: string
}

interface FireOutputDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  io: IoItem | null
  onFireOutput: (io: IoItem, action: 'start' | 'stop' | 'toggle') => void
  autoCloseOnRelease?: boolean
}

export function FireOutputDialog({
  open,
  onOpenChange,
  io,
  onFireOutput,
  autoCloseOnRelease = false,
}: FireOutputDialogProps) {
  const [isHolding, setIsHolding] = useState(false)
  const ioRef = useRef(io)
  const isPressedRef = useRef(false)
  const startPromiseRef = useRef<Promise<void> | null>(null)

  useEffect(() => { ioRef.current = io }, [io])

  // Sync state from PLC when dialog opens
  useEffect(() => {
    if (open && io) {
      authFetch(`/api/ios/${io.id}/state`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.state !== undefined) {
            console.log(`[Fire] Synced state for ${io.name}: ${data.state}`)
          }
        })
        .catch(() => {})
    }
  }, [open, io])

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      isPressedRef.current = false
      setIsHolding(false)
    }
  }, [open])

  // Press down: fire ON immediately
  const handlePressStart = useCallback((e: React.PointerEvent) => {
    if (!ioRef.current || isPressedRef.current) return
    e.preventDefault()
    // Capture pointer so we get pointerup even if finger moves off button
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)

    isPressedRef.current = true
    setIsHolding(true)
    // Fire start, keep promise so stop can wait for it
    startPromiseRef.current = Promise.resolve(onFireOutput(ioRef.current, 'start'))
  }, [onFireOutput])

  // Release: wait for start to finish, then fire OFF
  const handlePressEnd = useCallback(async (e: React.PointerEvent) => {
    if (!isPressedRef.current || !ioRef.current) return
    e.preventDefault()

    const currentIo = ioRef.current
    isPressedRef.current = false
    setIsHolding(false)

    // Wait for start to complete before sending stop
    if (startPromiseRef.current) {
      await startPromiseRef.current
      startPromiseRef.current = null
    }
    onFireOutput(currentIo, 'stop')

    if (autoCloseOnRelease) {
      setTimeout(() => onOpenChange(false), 150)
    }
  }, [onFireOutput, autoCloseOnRelease, onOpenChange])

  // Handle pointer cancel (e.g. system gesture)
  const handlePressCancel = useCallback(async () => {
    if (!isPressedRef.current) return

    isPressedRef.current = false
    setIsHolding(false)

    if (startPromiseRef.current) {
      await startPromiseRef.current
      startPromiseRef.current = null
    }
    if (ioRef.current) {
      onFireOutput(ioRef.current, 'stop')
    }
  }, [onFireOutput])

  // Close dialog — ensure output turns OFF
  const handleOpenChange = useCallback(async (isOpen: boolean) => {
    if (!isOpen) {
      if (isPressedRef.current && ioRef.current) {
        isPressedRef.current = false
        setIsHolding(false)
        if (startPromiseRef.current) {
          await startPromiseRef.current
          startPromiseRef.current = null
        }
        onFireOutput(ioRef.current, 'stop')
      }
      onOpenChange(false)
    } else {
      onOpenChange(true)
    }
  }, [onFireOutput, onOpenChange])

  if (!io) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Fire Output</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* IO Information */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Tag:</span>
              <Badge variant="outline" className="font-mono">
                {io.name}
              </Badge>
            </div>
            {io.description && (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Description:</span>
                <span className="text-sm text-muted-foreground">{io.description}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">State:</span>
              <Badge variant={io.state === 'TRUE' ? 'default' : 'secondary'}>
                {io.state === 'TRUE' ? 'ON' : 'OFF'}
              </Badge>
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
            <span className="text-sm text-amber-700 dark:text-amber-300">
              <strong>TAP</strong> = pulse ON then OFF &nbsp;|&nbsp; <strong>HOLD</strong> = stays ON while held
            </span>
          </div>

          {/* Fire Button — uses pointer events for unified mouse+touch */}
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              className={`w-48 h-24 text-xl font-bold select-none rounded-lg flex items-center justify-center transition-transform ${
                isHolding
                  ? 'bg-red-600 text-white ring-4 ring-red-300 animate-pulse scale-105'
                  : 'bg-orange-500 hover:bg-orange-600 text-white active:scale-95'
              }`}
              style={{ touchAction: 'none' }}
              onPointerDown={handlePressStart}
              onPointerUp={handlePressEnd}
              onPointerCancel={handlePressCancel}
            >
              <Zap className="w-6 h-6 mr-2" />
              {isHolding ? 'FIRING...' : 'FIRE'}
            </button>
            {isHolding && (
              <span className="text-sm text-red-600 font-medium animate-pulse">
                Output ON — release to stop
              </span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
