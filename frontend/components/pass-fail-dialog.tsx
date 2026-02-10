"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle, XCircle, AlertTriangle } from "lucide-react"

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

interface PassFailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  io: IoItem | null
  isTesting: boolean
  onPass: (io: IoItem) => void
  onFail: (io: IoItem) => void
}

export function PassFailDialog({
  open,
  onOpenChange,
  io,
  isTesting,
  onPass,
  onFail
}: PassFailDialogProps) {
  const [isProcessing, setIsProcessing] = useState(false)

  const handlePass = async () => {
    if (!io) return
    setIsProcessing(true)
    try {
      await onPass(io)
      onOpenChange(false)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleFail = async () => {
    if (!io) return
    setIsProcessing(true)
    try {
      await onFail(io)
      onOpenChange(false)
    } finally {
      setIsProcessing(false)
    }
  }

  if (!io) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Test Result</DialogTitle>
          <DialogDescription>
            Mark the test result for this IO point
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* IO Information */}
          <div className="space-y-2">
            <div>
              <span className="font-medium">Tag:</span>{" "}
              <span className="font-mono text-primary">{io.name}</span>
            </div>
            <div>
              <span className="font-medium">Description:</span>{" "}
              <span className="text-muted-foreground">{io.description || 'No description'}</span>
            </div>
            <div>
              <span className="font-medium">Subsystem:</span>{" "}
              <Badge variant="outline">{io.subsystemName}</Badge>
            </div>
            {io.state && (
              <div>
                <span className="font-medium">Current State:</span>{" "}
                <Badge 
                  variant={io.state === 'ON' || io.state === 'HIGH' || io.state === 'ACTIVE' ? 'default' : 'outline'}
                  className={io.state === 'ON' || io.state === 'HIGH' || io.state === 'ACTIVE' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}
                >
                  {io.state === 'ON' || io.state === 'HIGH' || io.state === 'ACTIVE' ? '✓' : '✗'}
                </Badge>
              </div>
            )}
          </div>

          {/* Current Result */}
          {io.result && (
            <div>
              <span className="font-medium">Current Result:</span>{" "}
              <Badge 
                variant={io.result === 'Passed' ? 'default' : 'destructive'}
                className={io.result === 'Passed' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}
              >
                {io.result}
              </Badge>
            </div>
          )}

          {/* Fire Output Button for Outputs */}
          {io.name?.includes(':O.') && (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg">
              <div className="text-sm text-amber-600 dark:text-amber-400 mb-2">
                <AlertTriangle className="w-4 h-4 inline mr-1" />
                This is an output. Make sure to fire the output before testing.
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isProcessing}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handleFail}
            disabled={!isTesting || isProcessing}
            className="w-full sm:w-auto border-red-500 text-red-600 hover:bg-red-50"
          >
            <XCircle className="w-4 h-4 mr-2" />
            Fail
          </Button>
          <Button
            onClick={handlePass}
            disabled={!isTesting || isProcessing}
            className="w-full sm:w-auto bg-green-600 hover:bg-green-700"
          >
            <CheckCircle className="w-4 h-4 mr-2" />
            Pass
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
