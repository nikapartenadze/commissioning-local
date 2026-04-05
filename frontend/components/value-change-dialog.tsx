"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

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

interface ValueChangeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  io: IoItem | null
  remainingCount?: number
  deviceFaulted?: boolean
  onYes: (io: IoItem) => void
  onNo: (io: IoItem) => void
  onCancel: (io: IoItem) => void
  onClearAll?: () => void
  onStopTesting?: () => void
}

export function ValueChangeDialog({
  open,
  onOpenChange,
  io,
  remainingCount = 0,
  onYes,
  onNo,
  onCancel,
  onClearAll,
  onStopTesting,
  deviceFaulted = false
}: ValueChangeDialogProps) {
  if (!io) return null

  const isSpare = io.description?.toUpperCase().includes('SPARE')

  const isOutput = (ioName: string | null): boolean => {
    if (!ioName) return false
    return ioName.includes(':O.') || ioName.includes(':SO.') || ioName.includes('.O.') || ioName.includes(':O:') || ioName.includes('.Outputs.') || ioName.endsWith('.DO') || ioName.endsWith('_DO')
  }

  const isOutputTag = isOutput(io.name)

  const handleYes = () => {
    onYes(io)
    onOpenChange(false)
  }

  const handleNo = () => {
    onNo(io)
    onOpenChange(false)
  }

  const handleCancel = () => {
    onCancel(io)
    onOpenChange(false)
  }

  // Handle dialog close attempt (clicking outside, pressing Escape)
  // Treat as Cancel to prevent queue from freezing
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && io) {
      // User is closing dialog without clicking Pass/Fail - treat as Cancel
      onCancel(io)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isSpare ? 'SPARE IO Triggered' : isOutputTag ? 'Output fired' : 'Input value changed'}</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* IO Information */}
          <div className="space-y-3">
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
            {deviceFaulted && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg space-y-1">
                <div className="text-sm font-bold text-center text-red-600 dark:text-red-400">
                  Parent device is FAULTED — connection issue detected
                </div>
                <div className="text-xs text-center text-red-500 dark:text-red-400/80">
                  Cannot test — device has a connection fault. Fix the fault first.
                </div>
              </div>
            )}
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-sm font-medium text-center">
                {isSpare ? (
                  <>
                    This IO is marked as SPARE. Skip or mark as{' '}
                    <Badge
                      variant="destructive"
                      className="text-sm font-bold mx-1"
                    >
                      Failed
                    </Badge>
                  </>
                ) : isOutputTag ? (
                  <>
                    Output was fired. Did it work correctly?{' '}
                    <Badge
                      variant="default"
                      className="text-sm font-bold mx-1"
                    >
                      Pass or Fail?
                    </Badge>
                  </>
                ) : (
                  <>
                    Input value changed to{' '}
                    <Badge
                      variant="default"
                      className="text-sm font-bold mx-1"
                    >
                      True
                    </Badge>
                    {' '}pass or not?
                  </>
                )}
              </div>
            </div>

            {/* Live counter for remaining dialogs */}
            {remainingCount > 0 && (
              <div className="p-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                <div className="text-xs font-medium text-center text-yellow-600 dark:text-yellow-400 flex items-center justify-center gap-2">
                  <span>{remainingCount} more {remainingCount === 1 ? 'test' : 'tests'} waiting...</span>
                  {onClearAll && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-100"
                      onClick={onClearAll}
                    >
                      Clear All
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex justify-between items-center gap-2">
            {onStopTesting ? (
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-950"
                onClick={() => {
                  onStopTesting()
                  onOpenChange(false)
                }}
              >
                Stop Testing
              </Button>
            ) : <div />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleCancel}>
                {isSpare ? 'Skip' : 'Cancel'}
              </Button>
              <Button variant="destructive" onClick={handleNo} disabled={deviceFaulted}>
                Fail
              </Button>
              {!isSpare && (
                <Button onClick={handleYes} disabled={deviceFaulted}>
                  Pass
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
