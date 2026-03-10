"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
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
}

export function FireOutputDialog({
  open,
  onOpenChange,
  io,
  onFireOutput,
}: FireOutputDialogProps) {
  const [isHolding, setIsHolding] = useState(false)
  const ioRef = useRef(io)
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isHoldModeRef = useRef(false)
  const isPressedRef = useRef(false)
  const HOLD_DELAY_MS = 200

  useEffect(() => { ioRef.current = io }, [io])

  // Sync state from PLC when dialog opens
  useEffect(() => {
    if (open && io) {
      authFetch(`/api/ios/${io.id}/state`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data?.state !== undefined) {
            console.log(`🔥 Fire dialog synced state for ${io.name}: ${data.state}`)
          }
        })
        .catch(() => {})
    }
  }, [open, io])

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      isPressedRef.current = false
      isHoldModeRef.current = false
      setIsHolding(false)
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
    }
  }, [open])

  const closeDialog = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  // Press down: start timer to detect hold vs click
  const handlePressStart = useCallback(() => {
    if (!ioRef.current || isPressedRef.current) return

    isPressedRef.current = true
    isHoldModeRef.current = false

    // Start timer — if still pressed after delay, it's a hold: turn ON
    holdTimerRef.current = setTimeout(() => {
      if (isPressedRef.current && ioRef.current) {
        isHoldModeRef.current = true
        setIsHolding(true)
        onFireOutput(ioRef.current, 'start') // Turn ON
      }
    }, HOLD_DELAY_MS)
  }, [onFireOutput])

  // Release: if click → pulse (ON then OFF), if hold → turn OFF, then auto-close
  const handlePressEnd = useCallback(() => {
    if (!isPressedRef.current || !ioRef.current) return

    // Clear hold timer
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }

    const currentIo = ioRef.current
    isPressedRef.current = false
    setIsHolding(false)

    if (isHoldModeRef.current) {
      // Was holding — turn OFF on release
      onFireOutput(currentIo, 'stop')
    } else {
      // Quick click — pulse: ON then OFF
      onFireOutput(currentIo, 'start')
      // Small delay then turn OFF
      setTimeout(() => {
        onFireOutput(currentIo, 'stop')
      }, 150)
    }
    isHoldModeRef.current = false

    // Auto-close dialog after action
    setTimeout(closeDialog, 300)
  }, [onFireOutput, closeDialog])

  // Handle pointer leaving button while pressed
  const handlePressCancel = useCallback(() => {
    if (!isPressedRef.current) return

    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }

    if (isHoldModeRef.current && ioRef.current) {
      // Was holding — turn OFF
      onFireOutput(ioRef.current, 'stop')
    }

    isPressedRef.current = false
    isHoldModeRef.current = false
    setIsHolding(false)

    // Auto-close if we were in hold mode
    setTimeout(closeDialog, 300)
  }, [onFireOutput, closeDialog])

  // Also close on dialog dismiss (clicking outside / ESC)
  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      if (isPressedRef.current && isHoldModeRef.current && ioRef.current) {
        onFireOutput(ioRef.current, 'stop')
      }
      isPressedRef.current = false
      isHoldModeRef.current = false
      setIsHolding(false)
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
      onOpenChange(false)
    } else {
      onOpenChange(true)
    }
  }, [onFireOutput, onOpenChange])

  if (!io) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
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
              <strong>TAP</strong> = pulse ON→OFF &nbsp;|&nbsp; <strong>HOLD</strong> = stays ON while held
            </span>
          </div>

          {/* Fire Button */}
          <div className="flex flex-col items-center gap-3">
            <Button
              size="lg"
              className={`w-48 h-24 text-xl font-bold select-none touch-none transition-transform ${
                isHolding
                  ? 'bg-red-600 hover:bg-red-600 text-white ring-4 ring-red-300 animate-pulse scale-105'
                  : 'bg-orange-500 hover:bg-orange-600 text-white'
              }`}
              onMouseDown={handlePressStart}
              onMouseUp={handlePressEnd}
              onMouseLeave={handlePressCancel}
              onTouchStart={handlePressStart}
              onTouchEnd={handlePressEnd}
              onTouchCancel={handlePressCancel}
            >
              <Zap className="w-6 h-6 mr-2" />
              {isHolding ? 'FIRING...' : 'FIRE'}
            </Button>
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
