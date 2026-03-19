"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, Trash2, Clock, CheckCircle, XCircle, CloudUpload } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"

interface ChangeRequest {
  id: number
  ioId: number | null
  requestType: string
  currentValue: string | null
  requestedValue: string | null
  structuredChanges: string | null
  reason: string
  requestedBy: string
  status: string
  createdAt: string
  reviewedBy: string | null
  reviewNote: string | null
}

interface ChangeRequestsPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }> = {
  pending: { label: 'Pending', variant: 'outline', icon: Clock },
  approved: { label: 'Approved', variant: 'default', icon: CheckCircle },
  rejected: { label: 'Rejected', variant: 'destructive', icon: XCircle },
  synced: { label: 'Synced', variant: 'secondary', icon: CloudUpload },
}

const TYPE_LABELS: Record<string, string> = {
  add: 'Add IO',
  modify: 'Modify IO',
  remove: 'Remove IO',
}

export function ChangeRequestsPanel({ open, onOpenChange }: ChangeRequestsPanelProps) {
  const { toast } = useToast()
  const [requests, setRequests] = useState<ChangeRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<string>('all')

  useEffect(() => {
    if (open) loadRequests()
  }, [open])

  const loadRequests = async () => {
    try {
      setLoading(true)
      const url = filter === 'all'
        ? API_ENDPOINTS.changeRequests
        : `${API_ENDPOINTS.changeRequests}?status=${filter}`
      const response = await authFetch(url)
      if (response.ok) {
        const data = await response.json()
        setRequests(data.requests || [])
      }
    } catch (error) {
      console.error('Error loading change requests:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) loadRequests()
  }, [filter])

  const handleCancel = async (id: number) => {
    if (!confirm('Cancel this change request?')) return
    try {
      const response = await authFetch(API_ENDPOINTS.changeRequestById(id), { method: 'DELETE' })
      if (response.ok) {
        await loadRequests()
        toast({ title: "Cancelled", description: "Change request cancelled" })
      } else {
        const err = await response.json()
        toast({ title: "Error", description: err.error || 'Failed to cancel', variant: "destructive" })
      }
    } catch {
      toast({ title: "Error", description: "Failed to cancel request", variant: "destructive" })
    }
  }

  const filtered = requests // already filtered by API if filter !== 'all'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Change Requests</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2 mb-4">
          {['all', 'pending', 'approved', 'rejected'].map(f => (
            <Button
              key={f}
              variant={filter === f ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No change requests</p>
          ) : (
            filtered.map(req => {
              const statusConfig = STATUS_CONFIG[req.status] || STATUS_CONFIG.pending
              const StatusIcon = statusConfig.icon
              return (
                <Card key={req.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={statusConfig.variant} className="gap-1">
                            <StatusIcon className="h-3 w-3" />
                            {statusConfig.label}
                          </Badge>
                          <Badge variant="outline">{TYPE_LABELS[req.requestType] || req.requestType}</Badge>
                        </div>
                        {req.currentValue && (
                          <p className="text-sm font-mono text-muted-foreground truncate">{req.currentValue}</p>
                        )}
                        {req.structuredChanges && (() => {
                          try {
                            const sc = JSON.parse(req.structuredChanges)
                            if (sc.changes) {
                              return (
                                <div className="text-sm mt-1 space-y-0.5">
                                  {Object.entries(sc.changes as Record<string, string>).map(([field, val]) => (
                                    <p key={field}><strong>{field}:</strong> <span className="font-mono">{val}</span></p>
                                  ))}
                                </div>
                              )
                            }
                            if (sc.name) {
                              return <p className="text-sm mt-1 font-mono">{sc.name}{sc.description ? ` — ${sc.description}` : ''}</p>
                            }
                          } catch { /* ignore parse errors */ }
                          return null
                        })()}
                        {!req.structuredChanges && req.requestedValue && (
                          <p className="text-sm mt-1"><strong>Requested:</strong> {req.requestedValue}</p>
                        )}
                        <p className="text-sm mt-1"><strong>Reason:</strong> {req.reason}</p>
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                          <span>By {req.requestedBy}</span>
                          <span>{new Date(req.createdAt).toLocaleString()}</span>
                        </div>
                        {req.reviewNote && (
                          <div className="mt-2 p-2 bg-muted rounded text-sm">
                            <strong>Review:</strong> {req.reviewNote}
                            {req.reviewedBy && <span className="text-muted-foreground"> — {req.reviewedBy}</span>}
                          </div>
                        )}
                      </div>
                      {req.status === 'pending' && (
                        <Button size="sm" variant="ghost" onClick={() => handleCancel(req.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
