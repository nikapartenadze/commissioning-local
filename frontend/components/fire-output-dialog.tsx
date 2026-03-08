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

  // Simple click toggle: click once = start, click again = stop
  const handleToggleFire = useCallback(() => {
    if (!isTesting || !ioRef.current) return

    if (isFiringRef.current) {
      // Currently firing → stop
      isFiringRef.current = false
      setIsFiring(false)
      onFireOutput(ioRef.current, 'stop')
    } else {
      // Not firing → start
      isFiringRef.current = true
      setIsFiring(true)
      onFireOutput(ioRef.current, 'start')
    }
  }, [isTesting, onFireOutput])

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
              Click <strong>FIRE</strong> to turn output ON. Click <strong>STOP</strong> to turn it OFF.
              Watch the State badge update. Pass/fail prompt appears after stopping if PLC responded.
            </span>
          </div>

          {/* Fire / Stop Button */}
          <div className="flex flex-col items-center gap-3">
            <Button
              size="lg"
              className={`w-40 h-20 text-lg font-bold select-none ${
                isFiring
                  ? 'bg-red-600 hover:bg-red-700 text-white ring-4 ring-red-300'
                  : 'bg-green-500 hover:bg-green-600 text-white'
              } ${!isTesting ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={handleToggleFire}
              disabled={!isTesting}
            >
              {isFiring ? (
                <>
                  <Square className="w-5 h-5 mr-2" />
                  STOP
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 mr-2" />
                  FIRE
                </>
              )}
            </Button>
            {isFiring && (
              <span className="text-sm text-red-600 font-medium animate-pulse">
                Output is ON — click STOP when done
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
