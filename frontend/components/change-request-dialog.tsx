"use client"

import { useState } from "react"
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
  const [requestedValue, setRequestedValue] = useState("")
  const [reason, setReason] = useState("")

  const handleSubmit = async () => {
    if (!reason.trim()) {
      toast({ title: "Error", description: "Please provide a reason", variant: "destructive" })
      return
    }
    try {
      setSubmitting(true)
      const response = await authFetch(API_ENDPOINTS.changeRequests, {
        method: 'POST',
        body: JSON.stringify({
          ioId: io?.id || null,
          requestType,
          currentValue: io ? `${io.name} — ${io.description || 'No description'}` : null,
          requestedValue: requestedValue.trim() || null,
          reason: reason.trim(),
          requestedBy: currentUser || 'Unknown',
        }),
      })
      if (response.ok) {
        toast({ title: "Request Submitted", description: "Your change request has been sent for review" })
        setRequestedValue("")
        setReason("")
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

          {requestType !== 'remove' && (
            <div className="space-y-2">
              <Label>Requested Change</Label>
              <Input
                value={requestedValue}
                onChange={(e) => setRequestedValue(e.target.value)}
                placeholder={requestType === 'add' ? "Describe the new IO..." : "What should it be changed to..."}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>Reason</Label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this change needed?"
              className="w-full min-h-[80px] px-3 py-2 border rounded bg-background text-sm resize-y"
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
