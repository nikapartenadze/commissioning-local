"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Play, Square, X } from "lucide-react"
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
  isTesting: boolean
}

export function FireOutputDialog({
  open,
  onOpenChange,
  io,
  onFireOutput,
  isTesting
}: FireOutputDialogProps) {
  const [isFiring, setIsFiring] = useState(false)
  const isFiringRef = useRef(false)
  const ioRef = useRef(io)
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isHoldModeRef = useRef(false)
  const HOLD_DELAY_MS = 200 // After this delay, it's a hold (not a click)

  useEffect(() => { ioRef.current = io }, [io])

  // Sync state from PLC when dialog opens
  useEffect(() => {
    if (open && io) {
      // Fetch current state from PLC to ensure UI is in sync
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
      isFiringRef.current = false
      isHoldModeRef.current = false
      setIsFiring(false)
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
    }
  }, [open])

  // On press: start timer, if held long enough = hold mode
  const handleFireStart = useCallback(() => {
    if (!isTesting || !ioRef.current || isFiringRef.current) return

    isFiringRef.current = true
    isHoldModeRef.current = false
    setIsFiring(true)

    // Start a timer - if still pressed after delay, enter hold mode and turn ON
    holdTimerRef.current = setTimeout(() => {
      if (isFiringRef.current && ioRef.current) {
        isHoldModeRef.current = true
        onFireOutput(ioRef.current, 'start')
      }
    }, HOLD_DELAY_MS)
  }, [isTesting, onFireOutput])

  // On release: if quick click = toggle, if hold = turn OFF
  const handleFireStop = useCallback(() => {
    if (!isFiringRef.current || !ioRef.current) return

    // Clear the hold timer
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }

    isFiringRef.current = false
    setIsFiring(false)

    if (isHoldModeRef.current) {
      // Was holding - turn OFF on release
      onFireOutput(ioRef.current, 'stop')
    } else {
      // Quick click - toggle the state
      onFireOutput(ioRef.current, 'toggle')
    }
    isHoldModeRef.current = false
  }, [onFireOutput])

  // Handle mouse/touch leaving the button area while pressed
  const handleFireCancel = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (isFiringRef.current && ioRef.current) {
      isFiringRef.current = false
      setIsFiring(false)
      if (isHoldModeRef.current) {
        // Was in hold mode - turn OFF
        onFireOutput(ioRef.current, 'stop')
      }
      // If not in hold mode yet, just cancel without any action
      isHoldModeRef.current = false
    }
  }, [onFireOutput])

  const handleClose = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (isFiringRef.current && ioRef.current && isHoldModeRef.current) {
      onFireOutput(ioRef.current, 'stop')
    }
    isFiringRef.current = false
    isHoldModeRef.current = false
    setIsFiring(false)
    onOpenChange(false)
  }, [onFireOutput, onOpenChange])

  if (!io) return null

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) handleClose()
      else onOpenChange(true)
    }}>
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
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Description:</span>
              <span className="text-sm text-muted-foreground">
                {io.description || 'No description'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Current State:</span>
              <Badge
                variant={io.state === 'TRUE' ? 'default' : 'destructive'}
                className={`text-xs transition-all duration-300 ${
                  io.state === 'TRUE' ? 'animate-pulse' : ''
                }`}
              >
                {io.state === 'TRUE' ? 'ON' : 'OFF'}
              </Badge>
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
            <span className="text-sm text-amber-700 dark:text-amber-300">
              <strong>CLICK</strong> = toggle ON/OFF. <strong>HOLD</strong> = keeps ON while holding.
            </span>
          </div>

          {/* Single Fire Button - Click to toggle, Hold to keep ON */}
          <div className="flex flex-col items-center gap-3">
            <Button
              size="lg"
              className={`w-48 h-24 text-xl font-bold select-none touch-none ${
                isFiring
                  ? 'bg-red-600 hover:bg-red-600 text-white ring-4 ring-red-300 animate-pulse scale-105'
                  : io.state === 'TRUE'
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'bg-green-500 hover:bg-green-600 text-white'
              } ${!isTesting ? 'opacity-50 cursor-not-allowed' : ''} transition-transform`}
              onMouseDown={handleFireStart}
              onMouseUp={handleFireStop}
              onMouseLeave={handleFireCancel}
              onTouchStart={handleFireStart}
              onTouchEnd={handleFireStop}
              onTouchCancel={handleFireCancel}
              disabled={!isTesting}
            >
              {isFiring ? (
                <>
                  <Square className="w-6 h-6 mr-2" />
                  HOLDING...
                </>
              ) : (
                <>
                  <Play className="w-6 h-6 mr-2" />
                  {io.state === 'TRUE' ? 'ON' : 'OFF'}
                </>
              )}
            </Button>
            {isFiring && (
              <span className="text-sm text-red-600 font-medium animate-pulse">
                Output is ON — release to stop
              </span>
            )}
          </div>

          {!isTesting && (
            <div className="text-center text-sm text-muted-foreground">
              Start testing to enable output firing
            </div>
          )}

          {/* Close button */}
          <div className="flex justify-end pt-2 border-t">
            <Button variant="outline" size="sm" onClick={handleClose}>
              <X className="w-4 h-4 mr-1" />
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
