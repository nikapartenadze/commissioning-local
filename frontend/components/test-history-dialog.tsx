"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { formatTimestamp, getResultBadgeVariant } from "@/lib/utils"
import { X, FileDown } from "lucide-react"

type TestHistory = {
  id: number
  result: string | null
  state: string | null
  comments: string | null
  testedBy: string | null
  timestamp: string
}

interface TestHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ioName: string
  ioDescription: string | null
  history: TestHistory[]
}

export function TestHistoryDialog({ 
  open, 
  onOpenChange, 
  ioName, 
  ioDescription, 
  history 
}: TestHistoryDialogProps) {
  
  const handleExportCSV = () => {
    const csv = [
      ['Date/Time', 'Result', 'State', 'Comments', 'Tested By'],
      ...history.map(h => [
        h.timestamp,
        h.result || '',
        h.state || '',
        h.comments || '',
        h.testedBy || ''
      ])
    ].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `test-history-${ioName}-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[60vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            Test History - {ioDescription || ioName} ({ioName})
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No test history available for this IO point.
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Date/Time
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Result
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    State
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Comments
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Tested By
                  </th>
                </tr>
              </thead>
              <tbody className="bg-background divide-y divide-border">
                {history.map((record) => (
                  <tr key={record.id} className="hover:bg-muted/50">
                    <td className="px-4 py-3 text-sm">
                      {formatTimestamp(record.timestamp)}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {record.result ? (
                        <Badge variant={getResultBadgeVariant(record.result)}>
                          {record.result}
                        </Badge>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {record.state ? (
                        record.state === 'Passed' || record.state === 'Failed' ? (
                          <div className="flex items-center gap-2">
                            {record.state === 'Passed' ? (
                              <span className="text-green-600 dark:text-green-400">✓</span>
                            ) : (
                              <span className="text-red-600 dark:text-red-400">✗</span>
                            )}
                            {record.state}
                          </div>
                        ) : (
                          record.state
                        )
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm max-w-md truncate" title={record.comments || ''}>
                      {record.comments || '-'}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {record.testedBy || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleExportCSV} disabled={history.length === 0}>
            <FileDown className="mr-2 h-4 w-4" />
            EXPORT TO CSV
          </Button>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            CLOSE
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

