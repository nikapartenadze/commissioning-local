"use client"

import { useState } from "react"
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

  if (!io) return null

  const handleMouseDown = () => {
    if (!isTesting) return
    setIsFiring(true)
    onFireOutput(io, 'start')
  }

  const handleMouseUp = () => {
    if (!isFiring) return
    setIsFiring(false)
    onFireOutput(io, 'stop')
    // Do NOT close — stay open so electrician sees the state change via SignalR.
    // The pass/fail dialog will appear when SignalR confirms the PLC state changed.
  }

  const handleMouseLeave = () => {
    if (isFiring) {
      setIsFiring(false)
      onFireOutput(io, 'stop')
      // Do NOT close — same reason as above
    }
  }

  const handleClose = () => {
    // If still firing when closing, stop first
    if (isFiring) {
      setIsFiring(false)
      onFireOutput(io, 'stop')
    }
    onOpenChange(false)
  }

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

          {/* Warning for outputs */}
          <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-amber-500 rounded-full"></div>
              <span className="text-sm text-amber-700 dark:text-amber-300">
                Hold the button to fire. Watch the State change while holding.
                Release when done — pass/fail prompt will appear if PLC responded.
              </span>
            </div>
          </div>

          {/* Fire Button */}
          <div className="flex flex-col items-center gap-3">
            <Button
              size="lg"
              className={`w-40 h-20 text-lg font-bold transition-all duration-150 select-none ${
                isFiring
                  ? 'bg-red-600 hover:bg-red-700 text-white scale-95 ring-4 ring-red-300'
                  : 'bg-green-500 hover:bg-green-600 text-white'
              } ${!isTesting ? 'opacity-50 cursor-not-allowed' : ''}`}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onTouchStart={handleMouseDown}
              onTouchEnd={handleMouseUp}
              disabled={!isTesting}
            >
              {isFiring ? (
                <>
                  <Square className="w-5 h-5 mr-2" />
                  HOLDING...
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
                Output is being fired — release when done
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
