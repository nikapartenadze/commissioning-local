"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HelpCircle, AlertCircle } from "lucide-react"

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
  const [showDiagnosticDialog, setShowDiagnosticDialog] = useState(false)

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
        const response = await fetch(`http://localhost:5000/api/diagnostics/failure-modes?tagType=${encodeURIComponent(io.tagType)}`)
        if (response.ok) {
          const modes = await response.json()
          setFailureModes([...modes, 'Other'])
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
      alert('Please select a failure reason')
      return
    }
    
    if (failureMode === 'Other' && !comment.trim()) {
      alert('Please provide comments when selecting "Other" as the failure reason')
      return
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

  const canShowDiagnostics = io.tagType && failureMode && failureMode !== 'Other'

  return (
    <>
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

            {/* Show diagnostic steps button */}
            {canShowDiagnostics && (
              <div className="p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDiagnosticDialog(true)}
                  className="w-full"
                >
                  <HelpCircle className="w-4 h-4 mr-2" />
                  Show Troubleshooting Steps
                </Button>
              </div>
            )}

            {/* Comment Input */}
            <div className="space-y-2">
              <Label htmlFor="comment">
                Additional Comments {failureMode === 'Other' && <span className="text-destructive">*</span>}
                {failureMode && failureMode !== 'Other' && <span className="text-muted-foreground text-xs">(optional)</span>}
              </Label>
              <Textarea
                id="comment"
                placeholder={
                  failureMode === 'Other' 
                    ? "Required - explain the specific issue..." 
                    : "Optional - add any additional notes..."
                }
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                className="resize-none"
              />
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

      {/* Diagnostic Steps Dialog */}
      {showDiagnosticDialog && io && (
        <DiagnosticStepsDialog
          open={showDiagnosticDialog}
          onOpenChange={setShowDiagnosticDialog}
          tagType={io.tagType || ''}
          failureMode={failureMode}
        />
      )}
    </>
  )
}

// Diagnostic Steps Dialog Component
interface DiagnosticStepsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tagType: string
  failureMode: string
}

function DiagnosticStepsDialog({ open, onOpenChange, tagType, failureMode }: DiagnosticStepsDialogProps) {
  const [steps, setSteps] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open && tagType && failureMode) {
      loadDiagnosticSteps()
    }
  }, [open, tagType, failureMode])

  const loadDiagnosticSteps = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(
        `http://localhost:5000/api/diagnostics/steps?tagType=${encodeURIComponent(tagType)}&failureMode=${encodeURIComponent(failureMode)}`
      )
      
      if (response.ok) {
        const data = await response.json()
        setSteps(data.steps)
      } else if (response.status === 404) {
        setError('No troubleshooting steps available for this failure mode.')
      } else {
        setError('Failed to load diagnostic steps.')
      }
    } catch (err) {
      console.error('Error loading diagnostic steps:', err)
      setError('Error loading diagnostic steps.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-blue-600" />
            Troubleshooting: {tagType}
          </DialogTitle>
          <div className="text-sm text-muted-foreground">
            Failure Mode: <Badge variant="secondary">{failureMode}</Badge>
          </div>
        </DialogHeader>
        
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-sm text-muted-foreground">Loading troubleshooting steps...</div>
            </div>
          ) : error ? (
            <div className="p-4 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">{error}</p>
            </div>
          ) : (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <div 
                className="whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: formatMarkdown(steps) }}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Simple markdown formatter (basic support)
function formatMarkdown(text: string): string {
  return text
    // Headers
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-4 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-6 mb-3">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-8 mb-4">$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Lists
    .replace(/^- (.+)$/gm, '<li class="ml-4">$1</li>')
    // Line breaks
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}
