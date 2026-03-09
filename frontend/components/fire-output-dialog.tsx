"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Play, Square, X } from "lucide-react"

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
  onFireOutput: (io: IoItem, action: 'start' | 'stop') => void
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

  useEffect(() => { ioRef.current = io }, [io])

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      isFiringRef.current = false
      setIsFiring(false)
    }
  }, [open])

  // Hold-to-fire: press and hold to keep output ON, release to turn OFF
  const handleFireStart = useCallback(() => {
    if (!isTesting || !ioRef.current || isFiringRef.current) return

    isFiringRef.current = true
    setIsFiring(true)
    onFireOutput(ioRef.current, 'start')
  }, [isTesting, onFireOutput])

  const handleFireStop = useCallback(() => {
    if (!isFiringRef.current || !ioRef.current) return

    isFiringRef.current = false
    setIsFiring(false)
    onFireOutput(ioRef.current, 'stop')
  }, [onFireOutput])

  // Handle mouse/touch leaving the button area while pressed
  const handleFireCancel = useCallback(() => {
    if (isFiringRef.current && ioRef.current) {
      isFiringRef.current = false
      setIsFiring(false)
      onFireOutput(ioRef.current, 'stop')
    }
  }, [onFireOutput])

  const handleClose = useCallback(() => {
    if (isFiringRef.current && ioRef.current) {
      isFiringRef.current = false
      setIsFiring(false)
      onFireOutput(ioRef.current, 'stop')
    }
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
              <strong>HOLD</strong> the FIRE button to keep output ON. <strong>RELEASE</strong> to turn it OFF.
              Watch the State badge update. Pass/fail prompt appears after release.
            </span>
          </div>

          {/* Fire Button - Hold to Fire */}
          <div className="flex flex-col items-center gap-3">
            <Button
              size="lg"
              className={`w-48 h-24 text-xl font-bold select-none touch-none ${
                isFiring
                  ? 'bg-red-600 hover:bg-red-600 text-white ring-4 ring-red-300 animate-pulse scale-105'
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
                  FIRING...
                </>
              ) : (
                <>
                  <Play className="w-6 h-6 mr-2" />
                  HOLD TO FIRE
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
