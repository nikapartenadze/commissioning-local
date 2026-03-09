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
  onYes: (io: IoItem) => void
  onNo: (io: IoItem) => void
  onCancel: (io: IoItem) => void
  onClearAll?: () => void
}

export function ValueChangeDialog({
  open,
  onOpenChange,
  io,
  remainingCount = 0,
  onYes,
  onNo,
  onCancel,
  onClearAll
}: ValueChangeDialogProps) {
  if (!io) return null

  const isOutput = (ioName: string | null): boolean => {
    if (!ioName) return false
    return ioName.includes(':O.') || ioName.includes(':SO.') || ioName.includes('.O.') || ioName.includes(':O:') || ioName.includes('.Outputs.') || ioName.endsWith('.DO')
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
          <DialogTitle>{isOutputTag ? 'Output fired' : 'Input value changed'}</DialogTitle>
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
            <div className="p-3 bg-muted rounded-lg">
              <div className="text-sm font-medium text-center">
                {isOutputTag ? (
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
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleNo}>
              Fail
            </Button>
            <Button onClick={handleYes}>
              Pass
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
