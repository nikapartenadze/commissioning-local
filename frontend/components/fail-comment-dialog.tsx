"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { useState } from "react"

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

interface FailCommentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  io: IoItem | null
  onSubmit: (io: IoItem, comment: string) => void
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

  if (!io) return null

  const handleSubmit = () => {
    if (!comment.trim()) {
      // Don't allow empty comments
      return
    }
    onSubmit(io, comment)
    setComment("") // Reset for next time
    onOpenChange(false)
  }

  const handleCancel = () => {
    setComment("") // Reset
    onCancel()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Why did this test fail?</DialogTitle>
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
          </div>

          {/* Comment Input */}
          <div className="space-y-2">
            <Label htmlFor="comment">
              Reason for failure <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="comment"
              placeholder="e.g., Output did not activate, wrong wiring, no response from PLC..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              className="resize-none"
            />
            {!comment.trim() && (
              <p className="text-xs text-muted-foreground">
                Please provide a reason for the failure
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button 
            variant="destructive" 
            onClick={handleSubmit}
            disabled={!comment.trim()}
          >
            Mark as Failed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

