"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Play, Square } from "lucide-react"

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
    // Close the dialog after firing is complete
    setTimeout(() => {
      onOpenChange(false)
    }, 100)
  }

  const handleMouseLeave = () => {
    if (isFiring) {
      setIsFiring(false)
      onFireOutput(io, 'stop')
      // Close the dialog after firing is complete
      setTimeout(() => {
        onOpenChange(false)
      }, 100)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                className="text-xs"
              >
                {io.state === 'TRUE' ? '✓' : '✗'}
              </Badge>
            </div>
          </div>

          {/* Warning for outputs */}
          <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
              <span className="text-sm text-blue-700 dark:text-blue-300">
                This is an output. Hold the button below to fire the output signal.
              </span>
            </div>
          </div>

          {/* Fire Button */}
          <div className="flex justify-center">
            <Button
              size="lg"
              className={`w-32 h-16 text-lg font-bold transition-all duration-150 ${
                isFiring 
                  ? 'bg-green-600 hover:bg-green-700 text-white' 
                  : 'bg-green-500 hover:bg-green-600 text-white'
              } ${!isTesting ? 'opacity-50 cursor-not-allowed' : ''}`}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              disabled={!isTesting}
            >
              {isFiring ? (
                <>
                  <Square className="w-5 h-5 mr-2" />
                  HOLDING
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 mr-2" />
                  FIRE
                </>
              )}
            </Button>
          </div>

          {!isTesting && (
            <div className="text-center text-sm text-muted-foreground">
              Start testing to enable output firing
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
