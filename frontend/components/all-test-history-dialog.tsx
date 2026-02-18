"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { formatTimestamp, getResultBadgeVariant } from "@/lib/utils"
import { FileDown, Search } from "lucide-react"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"

type TestHistoryRecord = {
  id: number
  ioId: number
  result: string | null
  state: string | null
  comments: string | null
  testedBy: string | null
  timestamp: string
  ioName: string
  ioDescription: string | null
  subsystemName: string
}

interface AllTestHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
  projectName: string
}

export function AllTestHistoryDialog({ 
  open, 
  onOpenChange, 
  projectId,
  projectName
}: AllTestHistoryDialogProps) {
  const [history, setHistory] = useState<TestHistoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")

  useEffect(() => {
    if (open) {
      fetchHistory()
    }
  }, [open, projectId])

  const fetchHistory = async () => {
    setLoading(true)
    try {
      const response = await authFetch(API_ENDPOINTS.history)
      if (response.ok) {
        const data = await response.json()
        setHistory(data)
      }
    } catch (error) {
      console.error('Error fetching project history:', error)
    } finally {
      setLoading(false)
    }
  }

  const filteredHistory = history.filter(record => {
    if (!searchTerm) return true
    const term = searchTerm.toLowerCase()
    return (
      record.ioName?.toLowerCase().includes(term) ||
      record.ioDescription?.toLowerCase().includes(term) ||
      record.subsystemName?.toLowerCase().includes(term) ||
      record.comments?.toLowerCase().includes(term) ||
      record.testedBy?.toLowerCase().includes(term)
    )
  })

  const handleExportCSV = () => {
    const csv = [
      ['Date/Time', 'IO Name', 'IO Description', 'Subsystem', 'Result', 'State', 'Comments', 'Tested By'],
      ...filteredHistory.map(h => [
        h.timestamp,
        h.ioName || '',
        h.ioDescription || '',
        h.subsystemName || '',
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
    a.download = `${projectName}-complete-test-history-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[85vw] max-h-[70vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-xl">
            Complete Test History - {projectName}
          </DialogTitle>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by IO name, description, subsystem, or comments..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-muted-foreground">Loading test history...</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Showing {filteredHistory.length} of {history.length} test records
            </p>

            <div className="flex-1 overflow-y-auto pr-2">
              <table className="w-full">
                <thead className="bg-muted sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Date/Time
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      IO Name
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Description
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Subsystem
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Result
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      State
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Comments
                    </th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Tested By
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-background divide-y divide-border">
                  {filteredHistory.map((record) => (
                    <tr key={record.id} className="hover:bg-muted/50">
                      <td className="px-3 py-3 text-sm whitespace-nowrap">
                        {formatTimestamp(record.timestamp)}
                      </td>
                      <td className="px-3 py-3 text-sm font-mono">
                        {record.ioName}
                      </td>
                      <td className="px-3 py-3 text-sm">
                        <div className="max-w-[200px] truncate" title={record.ioDescription || ''}>
                          {record.ioDescription || '-'}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-sm">
                        <Badge variant="outline" className="text-xs">
                          {record.subsystemName}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-sm">
                        {record.result ? (
                          <Badge variant={getResultBadgeVariant(record.result)} className="text-xs">
                            {record.result}
                          </Badge>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="px-3 py-3 text-sm">
                        {record.state ? (
                          record.state === 'Passed' || record.state === 'Failed' ? (
                            <div className="flex items-center gap-1">
                              {record.state === 'Passed' ? (
                                <span className="text-green-600 dark:text-green-400">✓</span>
                              ) : (
                                <span className="text-red-600 dark:text-red-400">✗</span>
                              )}
                              <span className="text-xs">{record.state}</span>
                            </div>
                          ) : (
                            record.state
                          )
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="px-3 py-3 text-sm">
                        <div className="max-w-[200px] truncate" title={record.comments || ''}>
                          {record.comments || '-'}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-sm">
                        {record.testedBy || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filteredHistory.length === 0 && !loading && (
                <div className="text-center py-8 text-muted-foreground">
                  {searchTerm ? 'No test history found matching your search.' : 'No test history available for this project.'}
                </div>
              )}
            </div>
          </>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleExportCSV} disabled={loading || history.length === 0}>
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

