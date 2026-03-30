"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"
import { toast } from "@/hooks/use-toast"

interface IoItem {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  state: string | null
  subsystemName: string
  tagType?: string | null
}

interface FailCommentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  io: IoItem | null
  onSubmit: (io: IoItem, comment: string, failureMode?: string) => void
  onCancel: () => void
}

export function FailCommentDialog({ 
  open, 
  onOpenChange, 
  io,
  onSubmit,
  onCancel
}: FailCommentDialogProps) {
  const [comment, setComment] = useState("")
  const [failureMode, setFailureMode] = useState("")
  const [failureModes, setFailureModes] = useState<string[]>([])
  const [loadingModes, setLoadingModes] = useState(false)

  // Load failure modes when dialog opens
  useEffect(() => {
    if (open && io) {
      setComment("")
      setFailureMode("")
      loadFailureModes()
    }
  }, [open, io])

  const loadFailureModes = async () => {
    if (!io) return

    setLoadingModes(true)
    try {
      // If tag has a type, load specific failure modes
      if (io.tagType) {
        const response = await fetch(`${API_ENDPOINTS.diagnosticFailureModes}?tagType=${encodeURIComponent(io.tagType)}`)
        if (response.ok) {
          const modes = await response.json()
          // Deduplicate — API may already include "Other"
          const unique = Array.from(new Set([...modes, 'Other']))
          setFailureModes(unique)
        } else {
          // Fallback to generic modes
          setFailureModes(['No response', 'Intermittent', 'Damaged', 'Wrong wiring', 'Other'])
        }
      } else {
        // Generic failure modes if no tag type
        setFailureModes(['No response', 'Intermittent', 'Damaged', 'Wrong wiring', 'Configuration error', 'Other'])
      }
    } catch (error) {
      console.error('Error loading failure modes:', error)
      // Fallback to generic modes
      setFailureModes(['No response', 'Intermittent', 'Damaged', 'Wrong wiring', 'Other'])
    } finally {
      setLoadingModes(false)
    }
  }

  if (!io) return null

  const handleSubmit = () => {
    // Validation
    if (!failureMode) {
      toast({ title: "Please select a failure reason", variant: "destructive" })
      return
    }

    if (failureMode === 'Other' && !comment.trim()) {
      return // validation shown inline
    }
    
    onSubmit(io, comment, failureMode)
    setComment("")
    setFailureMode("")
    onOpenChange(false)
  }

  const handleCancel = () => {
    setComment("")
    setFailureMode("")
    onCancel()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Mark as Failed</DialogTitle>
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
              {io.tagType && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Device Type:</span>
                  <Badge variant="secondary">{io.tagType}</Badge>
                </div>
              )}
            </div>

            {/* Failure Mode Selection */}
            <div className="space-y-2">
              <Label htmlFor="failureMode">
                Why did it fail? <span className="text-destructive">*</span>
              </Label>
              {loadingModes ? (
                <div className="text-sm text-muted-foreground">Loading failure modes...</div>
              ) : (
                <Select value={failureMode} onValueChange={setFailureMode}>
                  <SelectTrigger id="failureMode">
                    <SelectValue placeholder="Select a failure reason..." />
                  </SelectTrigger>
                  <SelectContent>
                    {failureModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {mode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {!failureMode && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  Required - select why the test failed
                </p>
              )}
            </div>

            {/* Comment Input */}
            <div className="space-y-2">
              <Label htmlFor="comment">
                {failureMode === 'Other' ? (
                  <span className="text-destructive font-semibold">Comment Required</span>
                ) : (
                  <>Additional Comments {failureMode && <span className="text-muted-foreground text-xs">(optional)</span>}</>
                )}
              </Label>
              <Textarea
                id="comment"
                placeholder={
                  failureMode === 'Other'
                    ? "Explain the specific issue..."
                    : "Optional - add any additional notes..."
                }
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={500}
                rows={4}
                className={cn("resize-none", failureMode === 'Other' && !comment.trim() && "border-destructive ring-1 ring-destructive")}
              />
              <p className="text-xs text-muted-foreground text-right">{comment.length}/500</p>
            </div>
          </div>

          <DialogFooter className="flex gap-2">
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleSubmit}
              disabled={!failureMode || (failureMode === 'Other' && !comment.trim())}
            >
              Mark as Failed
            </Button>
          </DialogFooter>
        </DialogContent>
    </Dialog>
  )
}
