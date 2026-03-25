"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle, XCircle, SkipForward } from "lucide-react"

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

type BatchDecision = 'pass' | 'fail' | 'skip' | null

interface BatchReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ios: IoItem[]
  onComplete: (decisions: Map<number, BatchDecision>) => void
  onStopTesting?: () => void
}

export function BatchReviewDialog({
  open,
  onOpenChange,
  ios,
  onComplete,
  onStopTesting,
}: BatchReviewDialogProps) {
  const [decisions, setDecisions] = useState<Map<number, BatchDecision>>(new Map())

  const setDecision = (ioId: number, decision: BatchDecision) => {
    setDecisions(prev => {
      const next = new Map(prev)
      if (decision === null) {
        next.delete(ioId)
      } else {
        next.set(ioId, decision)
      }
      return next
    })
  }

  const setAllDecisions = (decision: BatchDecision) => {
    const next = new Map<number, BatchDecision>()
    for (const io of ios) {
      next.set(io.id, decision)
    }
    setDecisions(next)
  }

  const isOutput = (ioName: string | null): boolean => {
    if (!ioName) return false
    return ioName.includes(':O.') || ioName.includes(':SO.') || ioName.includes('.O.') || ioName.includes(':O:') || ioName.includes('.Outputs.') || ioName.endsWith('.DO')
  }

  const handleDone = () => {
    // For any IO without a decision, default to skip
    const finalDecisions = new Map<number, BatchDecision>()
    for (const io of ios) {
      finalDecisions.set(io.id, decisions.get(io.id) || 'skip')
    }
    onComplete(finalDecisions)
    setDecisions(new Map())
  }

  const handleClose = () => {
    // Treat close as skip-all
    const skipAll = new Map<number, BatchDecision>()
    for (const io of ios) {
      skipAll.set(io.id, 'skip')
    }
    onComplete(skipAll)
    setDecisions(new Map())
  }

  const decidedCount = decisions.size
  const totalCount = ios.length

  if (ios.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={(newOpen) => {
      if (!newOpen) handleClose()
    }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            Multiple state changes detected
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {totalCount} inputs/outputs changed at the same time. Review them all at once.
          </p>
        </DialogHeader>

        {/* Bulk action buttons */}
        <div className="flex gap-2 pb-2 border-b">
          <Button size="sm" variant="default" onClick={() => setAllDecisions('pass')}>
            Pass All
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setAllDecisions('fail')}>
            Fail All
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAllDecisions('skip')}>
            Skip All
          </Button>
        </div>

        {/* Scrollable IO list */}
        <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
          {ios.map((io) => {
            const decision = decisions.get(io.id)
            const output = isOutput(io.name)
            return (
              <div
                key={io.id}
                className={`p-3 rounded-lg border transition-colors ${
                  decision === 'pass' ? 'bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800' :
                  decision === 'fail' ? 'bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800' :
                  decision === 'skip' ? 'bg-muted/50 border-muted' :
                  'bg-background border-border'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-xs shrink-0">
                        {output ? 'OUT' : 'IN'}
                      </Badge>
                      <span className="text-sm font-medium truncate">{io.name}</span>
                    </div>
                    {io.description && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {io.description}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant={decision === 'pass' ? 'default' : 'outline'}
                      className={`h-8 w-8 p-0 ${decision === 'pass' ? 'bg-green-600 hover:bg-green-700' : ''}`}
                      onClick={() => setDecision(io.id, decision === 'pass' ? null : 'pass')}
                      title="Pass"
                    >
                      <CheckCircle className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant={decision === 'fail' ? 'destructive' : 'outline'}
                      className="h-8 w-8 p-0"
                      onClick={() => setDecision(io.id, decision === 'fail' ? null : 'fail')}
                      title="Fail"
                    >
                      <XCircle className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant={decision === 'skip' ? 'secondary' : 'outline'}
                      className="h-8 w-8 p-0"
                      onClick={() => setDecision(io.id, decision === 'skip' ? null : 'skip')}
                      title="Skip"
                    >
                      <SkipForward className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center pt-2 border-t">
          <div className="flex items-center gap-2">
            {onStopTesting && (
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-950"
                onClick={() => {
                  handleClose()
                  onStopTesting()
                }}
              >
                Stop Testing
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {decidedCount}/{totalCount} reviewed
            </span>
          </div>
          <Button onClick={handleDone}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
