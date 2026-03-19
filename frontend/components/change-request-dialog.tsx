"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Send } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"

interface ChangeRequestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  io?: { id: number; name: string; description: string | null } | null
  currentUser?: string
}

export function ChangeRequestDialog({ open, onOpenChange, io, currentUser }: ChangeRequestDialogProps) {
  const { toast } = useToast()
  const [submitting, setSubmitting] = useState(false)
  const [requestType, setRequestType] = useState<'modify' | 'add' | 'remove'>(io ? 'modify' : 'add')
  const [mode, setMode] = useState<'structured' | 'freetext'>('structured')
  const [reason, setReason] = useState("")

  // Free-text mode
  const [requestedValue, setRequestedValue] = useState("")

  // Structured mode — modify
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")

  // Structured mode — add
  const [addName, setAddName] = useState("")
  const [addDescription, setAddDescription] = useState("")

  // Reset form when dialog opens or IO changes
  useEffect(() => {
    if (open) {
      setRequestType(io ? 'modify' : 'add')
      setMode('structured')
      setReason("")
      setRequestedValue("")
      setNewName("")
      setNewDescription("")
      setAddName("")
      setAddDescription("")
    }
  }, [open, io])

  const handleSubmit = async () => {
    if (!reason.trim()) {
      toast({ title: "Error", description: "Please provide a reason", variant: "destructive" })
      return
    }

    // Build structured changes if in structured mode
    let structuredChanges: Record<string, unknown> | null = null
    if (mode === 'structured') {
      if (requestType === 'modify' && io) {
        const changes: Record<string, string> = {}
        if (newName.trim() && newName.trim() !== io.name) changes.name = newName.trim()
        if (newDescription.trim() && newDescription.trim() !== (io.description || '')) changes.description = newDescription.trim()
        if (Object.keys(changes).length === 0) {
          toast({ title: "No Changes", description: "Enter at least one field to change", variant: "destructive" })
          return
        }
        structuredChanges = { ioId: io.id, field: 'multiple', changes }
      } else if (requestType === 'add') {
        if (!addName.trim()) {
          toast({ title: "Error", description: "IO name is required for add requests", variant: "destructive" })
          return
        }
        structuredChanges = {
          name: addName.trim(),
          description: addDescription.trim() || null,
        }
      } else if (requestType === 'remove' && io) {
        structuredChanges = { ioId: io.id, name: io.name }
      }
    }

    try {
      setSubmitting(true)

      // Build display-friendly requestedValue from structured data
      let displayValue = requestedValue.trim() || null
      if (mode === 'structured' && structuredChanges) {
        if (requestType === 'modify') {
          const c = (structuredChanges as { changes: Record<string, string> }).changes
          displayValue = Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(', ')
        } else if (requestType === 'add') {
          displayValue = `${(structuredChanges as { name: string }).name} — ${(structuredChanges as { description?: string }).description || 'No description'}`
        } else if (requestType === 'remove') {
          displayValue = null
        }
      }

      const response = await authFetch(API_ENDPOINTS.changeRequests, {
        method: 'POST',
        body: JSON.stringify({
          ioId: io?.id || null,
          requestType,
          currentValue: io ? `${io.name} — ${io.description || 'No description'}` : null,
          requestedValue: displayValue,
          structuredChanges,
          reason: reason.trim(),
          requestedBy: currentUser || 'Unknown',
        }),
      })
      if (response.ok) {
        toast({ title: "Request Submitted", description: "Your change request has been sent for review" })
        onOpenChange(false)
      } else {
        const err = await response.json()
        toast({ title: "Error", description: err.error || 'Failed to submit', variant: "destructive" })
      }
    } catch {
      toast({ title: "Error", description: "Failed to submit change request", variant: "destructive" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Request IO Change</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {io && (
            <div className="bg-muted p-3 rounded text-sm">
              <div className="font-mono font-medium">{io.name}</div>
              {io.description && <div className="text-muted-foreground">{io.description}</div>}
            </div>
          )}

          <div className="space-y-2">
            <Label>Change Type</Label>
            <select
              value={requestType}
              onChange={(e) => setRequestType(e.target.value as 'modify' | 'add' | 'remove')}
              className="w-full h-10 px-3 border rounded bg-background text-sm"
            >
              <option value="modify">Modify existing IO</option>
              <option value="add">Add new IO</option>
              <option value="remove">Remove IO</option>
            </select>
          </div>

          {/* Mode toggle — not shown for remove */}
          {requestType !== 'remove' && (
            <div className="flex gap-1 bg-muted p-1 rounded">
              <button
                onClick={() => setMode('structured')}
                className={`flex-1 text-sm py-1.5 rounded transition-colors ${
                  mode === 'structured' ? 'bg-background shadow font-medium' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Specific Fields
              </button>
              <button
                onClick={() => setMode('freetext')}
                className={`flex-1 text-sm py-1.5 rounded transition-colors ${
                  mode === 'freetext' ? 'bg-background shadow font-medium' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Free Text
              </button>
            </div>
          )}

          {/* Structured mode — Modify */}
          {requestType === 'modify' && mode === 'structured' && io && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">New IO Name <span className="text-muted-foreground">(leave blank to keep current)</span></Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={io.name}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">New Description <span className="text-muted-foreground">(leave blank to keep current)</span></Label>
                <Input
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder={io.description || 'No description'}
                  className="text-sm"
                />
              </div>
            </div>
          )}

          {/* Structured mode — Add */}
          {requestType === 'add' && mode === 'structured' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">IO Name <span className="text-red-500">*</span></Label>
                <Input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="e.g. Local:5:I.Data.15"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Description</Label>
                <Input
                  value={addDescription}
                  onChange={(e) => setAddDescription(e.target.value)}
                  placeholder="e.g. Photoeye conveyor 3 entry"
                  className="text-sm"
                />
              </div>
            </div>
          )}

          {/* Free-text mode */}
          {requestType !== 'remove' && mode === 'freetext' && (
            <div className="space-y-2">
              <Label>Describe the Change</Label>
              <textarea
                value={requestedValue}
                onChange={(e) => setRequestedValue(e.target.value)}
                placeholder={requestType === 'add' ? "Describe the new IO needed..." : "Describe what should be changed..."}
                className="w-full min-h-[60px] px-3 py-2 border rounded bg-background text-sm resize-y"
              />
            </div>
          )}

          {/* Remove confirmation */}
          {requestType === 'remove' && io && (
            <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3 rounded text-sm text-red-700 dark:text-red-400">
              Requesting removal of <strong>{io.name}</strong>
            </div>
          )}

          <div className="space-y-2">
            <Label>Reason <span className="text-red-500">*</span></Label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this change needed?"
              className="w-full min-h-[60px] px-3 py-2 border rounded bg-background text-sm resize-y"
            />
          </div>

          <Button onClick={handleSubmit} disabled={submitting || !reason.trim()} className="w-full">
            {submitting ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting...</>
            ) : (
              <><Send className="mr-2 h-4 w-4" /> Submit Request</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
