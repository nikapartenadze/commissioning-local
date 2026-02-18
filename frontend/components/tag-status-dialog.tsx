"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Copy, Download, AlertTriangle, CheckCircle, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export interface TagStatus {
  plcConnected: boolean
  totalTags: number
  successfulTags: number
  failedTags: number
  successRate: number
  hasErrors: boolean
  notFoundTags: string[]
  illegalTags: string[]
  unknownErrorTags: string[]
  lastUpdated: string | null
  plcIp: string
  plcPath: string
}

interface TagStatusDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tagStatus: TagStatus | null
}

export function TagStatusDialog({ open, onOpenChange, tagStatus }: TagStatusDialogProps) {
  if (!tagStatus) return null

  const copyToClipboard = () => {
    const lines = [
      `PLC Tag Status Report`,
      `Generated: ${new Date().toLocaleString()}`,
      ``,
      `PLC: ${tagStatus.plcIp} (Path: ${tagStatus.plcPath})`,
      `Connection: ${tagStatus.plcConnected ? "Connected" : "Disconnected"}`,
      ``,
      `Tags: ${tagStatus.successfulTags}/${tagStatus.totalTags} working (${tagStatus.successRate.toFixed(1)}%)`,
      ``,
    ]

    if (tagStatus.notFoundTags.length > 0) {
      lines.push(`NOT FOUND (${tagStatus.notFoundTags.length}):`)
      tagStatus.notFoundTags.forEach(tag => lines.push(`  - ${tag}`))
      lines.push(``)
    }

    if (tagStatus.illegalTags.length > 0) {
      lines.push(`ILLEGAL/ACCESS DENIED (${tagStatus.illegalTags.length}):`)
      tagStatus.illegalTags.forEach(tag => lines.push(`  - ${tag}`))
      lines.push(``)
    }

    if (tagStatus.unknownErrorTags.length > 0) {
      lines.push(`OTHER ERRORS (${tagStatus.unknownErrorTags.length}):`)
      tagStatus.unknownErrorTags.forEach(tag => lines.push(`  - ${tag}`))
    }

    navigator.clipboard.writeText(lines.join('\n'))
  }

  const downloadCsv = () => {
    const rows = [
      ['Tag Name', 'Error Type', 'Details'],
      ...tagStatus.notFoundTags.map(tag => [tag, 'NOT_FOUND', 'Tag does not exist in PLC']),
      ...tagStatus.illegalTags.map(tag => [tag, 'ILLEGAL', 'Access denied or invalid tag type']),
      ...tagStatus.unknownErrorTags.map(tag => {
        const parts = tag.split(': ')
        return [parts[0], 'ERROR', parts[1] || 'Unknown error']
      }),
    ]

    const csv = rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tag-errors-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {tagStatus.hasErrors ? (
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            ) : (
              <CheckCircle className="w-5 h-5 text-green-500" />
            )}
            PLC Tag Status
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-muted">
              <div className="text-sm text-muted-foreground">PLC Connection</div>
              <div className={cn(
                "text-lg font-bold",
                tagStatus.plcConnected ? "text-green-600" : "text-red-600"
              )}>
                {tagStatus.plcConnected ? "Connected" : "Disconnected"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {tagStatus.plcIp} ({tagStatus.plcPath})
              </div>
            </div>
            <div className="p-3 rounded-lg bg-muted">
              <div className="text-sm text-muted-foreground">Tags Working</div>
              <div className={cn(
                "text-lg font-bold",
                tagStatus.successRate === 100 ? "text-green-600" :
                tagStatus.successRate > 50 ? "text-amber-600" : "text-red-600"
              )}>
                {tagStatus.successfulTags} / {tagStatus.totalTags}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {tagStatus.successRate.toFixed(1)}% success rate
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full transition-all",
                tagStatus.successRate === 100 ? "bg-green-500" :
                tagStatus.successRate > 50 ? "bg-amber-500" : "bg-red-500"
              )}
              style={{ width: `${tagStatus.successRate}%` }}
            />
          </div>

          {/* Error Details */}
          {tagStatus.hasErrors && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-medium text-sm">Failed Tags ({tagStatus.failedTags})</h4>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={copyToClipboard} title="Copy to clipboard">
                    <Copy className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={downloadCsv} title="Download CSV">
                    <Download className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Not Found Tags */}
              {tagStatus.notFoundTags.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="destructive" className="text-xs">NOT FOUND</Badge>
                    <span className="text-xs text-muted-foreground">
                      Tag doesn't exist in PLC ({tagStatus.notFoundTags.length})
                    </span>
                  </div>
                  <div className="bg-red-500/10 border border-red-500/20 rounded p-2 max-h-24 overflow-y-auto">
                    <ul className="text-xs font-mono space-y-0.5">
                      {tagStatus.notFoundTags.map((tag, i) => (
                        <li key={i} className="text-red-600">{tag}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Illegal Tags */}
              {tagStatus.illegalTags.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs border-amber-500 text-amber-600">ILLEGAL</Badge>
                    <span className="text-xs text-muted-foreground">
                      Access denied or invalid type ({tagStatus.illegalTags.length})
                    </span>
                  </div>
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded p-2 max-h-24 overflow-y-auto">
                    <ul className="text-xs font-mono space-y-0.5">
                      {tagStatus.illegalTags.map((tag, i) => (
                        <li key={i} className="text-amber-600">{tag}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Unknown Error Tags */}
              {tagStatus.unknownErrorTags.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">OTHER ERRORS</Badge>
                    <span className="text-xs text-muted-foreground">
                      Module offline/faulted ({tagStatus.unknownErrorTags.length})
                    </span>
                  </div>
                  <div className="bg-slate-500/10 border border-slate-500/20 rounded p-2 max-h-32 overflow-y-auto">
                    <ul className="text-xs font-mono space-y-0.5">
                      {tagStatus.unknownErrorTags.map((tag, i) => (
                        <li key={i} className="text-slate-600 dark:text-slate-400">{tag}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* All good message */}
          {!tagStatus.hasErrors && tagStatus.totalTags > 0 && (
            <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg text-center">
              <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
              <div className="font-medium text-green-600">All {tagStatus.totalTags} tags validated successfully</div>
              <div className="text-sm text-muted-foreground mt-1">
                PLC communication is working correctly
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
