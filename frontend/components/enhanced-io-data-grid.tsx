"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TestHistoryDialog } from "@/components/test-history-dialog"
import { DiagnosticStepsDialog } from "@/components/diagnostic-steps-dialog"
import { formatTimestamp, getResultBadgeVariant } from "@/lib/utils"
import { TEST_CONSTANTS } from "@/lib/constants"
import { Search, History, X, Play, Square, AlertTriangle, CheckCircle, HelpCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { API_ENDPOINTS } from "@/lib/api-config"

type IoItem = {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  state: string | null
  subsystemName: string
  tagType?: string | null
  failureMode?: string | null
}

type TestHistory = {
  id: number
  result: string | null
  state: string | null
  comments: string | null
  testedBy: string | null
  timestamp: string
}

interface EnhancedIoDataGridProps {
  ios: IoItem[]
  projectId: number
  isTesting: boolean
  currentTestIo: IoItem | null
  onFilteredDataChange?: (filteredIos: IoItem[]) => void
  onFireOutput?: (io: IoItem, action: 'start' | 'stop') => void
  onMarkPassed?: (io: IoItem) => void
  onMarkFailed?: (io: IoItem) => void
  onClearResult?: (io: IoItem) => void
  onRowClick?: (io: IoItem) => void
  onShowFireOutputDialog?: (io: IoItem) => void
}

// Define column widths - these will be applied consistently to both header and body
const COLUMN_WIDTHS = {
  description: 280,
  ioPoint: 200,
  state: 90,
  result: 110,
  timestamp: 170,
  comments: 180,
  history: 80,
  help: 80,
  failed: 80,
  clear: 80,
  output: 80
}

export function EnhancedIoDataGrid({ 
  ios, 
  projectId, 
  isTesting,
  currentTestIo,
  onFilteredDataChange,
  onFireOutput,
  onMarkPassed,
  onMarkFailed,
  onClearResult,
  onRowClick,
  onShowFireOutputDialog
}: EnhancedIoDataGridProps) {
  const [searchTerm, setSearchTerm] = useState("")
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [selectedIo, setSelectedIo] = useState<IoItem | null>(null)
  const [showHistoryDialog, setShowHistoryDialog] = useState(false)
  const [historyData, setHistoryData] = useState<TestHistory[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [showStateColumn, setShowStateColumn] = useState(true)
  const [showResultColumn, setShowResultColumn] = useState(true)
  const [showTimestampColumn, setShowTimestampColumn] = useState(true)
  const [showDiagnosticDialog, setShowDiagnosticDialog] = useState(false)
  const [diagnosticIo, setDiagnosticIo] = useState<IoItem | null>(null)

  const handleShowHistory = async (io: IoItem) => {
    setSelectedIo(io)
    setLoadingHistory(true)
    setShowHistoryDialog(true)
    
    try {
      const response = await fetch(API_ENDPOINTS.ioHistory(io.id))
      if (response.ok) {
        const data = await response.json()
        setHistoryData(data)
      } else {
        setHistoryData([])
      }
    } catch (error) {
      console.error('Error fetching history:', error)
      setHistoryData([])
    } finally {
      setLoadingHistory(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === ' ' || e.key === 'Enter') && searchTerm.trim()) {
      e.preventDefault()
      const trimmedTerm = searchTerm.trim()
      if (trimmedTerm && !filterTags.includes(trimmedTerm)) {
        setFilterTags([...filterTags, trimmedTerm])
        setSearchTerm('')
      }
    } else if (e.key === 'Backspace' && searchTerm === '' && filterTags.length > 0) {
      setFilterTags(filterTags.slice(0, -1))
    }
  }

  const removeFilterTag = (tagToRemove: string) => {
    setFilterTags(filterTags.filter(tag => tag !== tagToRemove))
  }

  const clearAllFilters = () => {
    setFilterTags([])
    setSearchTerm('')
  }

  const filteredIos = useMemo(() => {
    const filtered = ios.filter(io => {
      if (filterTags.length === 0 && !searchTerm.trim()) return true
      
      const allTerms = [...filterTags]
      if (searchTerm.trim()) {
        allTerms.push(searchTerm.trim())
      }
      
      return allTerms.some(term => {
        const lowerTerm = term.toLowerCase()
        return (
          io.name?.toLowerCase().includes(lowerTerm) ||
          io.description?.toLowerCase().includes(lowerTerm) ||
          io.comments?.toLowerCase().includes(lowerTerm) ||
          io.timestamp?.toLowerCase().includes(lowerTerm) ||
          io.state?.toLowerCase().includes(lowerTerm)
        )
      })
    })
    return filtered
  }, [ios, filterTags, searchTerm])

  useEffect(() => {
    if (onFilteredDataChange) {
      onFilteredDataChange(filteredIos)
    }
  }, [filteredIos, onFilteredDataChange])

  // Virtual scrolling setup
  const parentRef = useRef<HTMLDivElement>(null)
  
  const virtualizer = useVirtualizer({
    count: filteredIos.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 10,
  })

  const getRowClassName = (io: IoItem) => {
    if (io.result === TEST_CONSTANTS.RESULT_PASSED) return "row-passed"
    if (io.result === TEST_CONSTANTS.RESULT_FAILED) return "row-failed"
    if (currentTestIo?.id === io.id) return "row-current-test"
    return "row-default"
  }

  const getStateDisplay = (state: string | null) => {
    if (!state || state === 'UNKNOWN') {
      return <X className="h-4 w-4 text-gray-500" />
    }
    
    if (state === 'TRUE' || state === 'ON' || state === 'HIGH' || state === 'ACTIVE' || state === '1') {
      return <CheckCircle className="h-4 w-4 text-green-500" />
    }
    if (state === 'FALSE' || state === 'OFF' || state === 'LOW' || state === 'INACTIVE' || state === '0') {
      return <X className="h-4 w-4 text-red-500" />
    }
    
    return <X className="h-4 w-4 text-gray-500" />
  }

  const isOutput = (ioName: string) => ioName.includes(':O.') || ioName.includes('.O.') || ioName.includes(':O:') || ioName.includes('.Outputs.') || ioName.endsWith('.DO') || ioName.toLowerCase().includes('output')

  const handleShowDiagnostic = async (io: IoItem) => {
    // If IO doesn't have failureMode, fetch it from history
    if (!io.failureMode && io.id) {
      try {
        const response = await fetch(API_ENDPOINTS.ioHistory(io.id))
        if (response.ok) {
          const history = await response.json()
          // Find the most recent failed entry with a failureMode
          const failedEntry = history.find((h: any) => h.result === 'Failed' && h.failureMode)
          if (failedEntry) {
            setDiagnosticIo({ ...io, failureMode: failedEntry.failureMode })
            setShowDiagnosticDialog(true)
            return
          }
        }
      } catch (error) {
        console.error('Error fetching history for diagnostic:', error)
      }
    }
    setDiagnosticIo(io)
    setShowDiagnosticDialog(true)
  }

  // Calculate total width based on visible columns
  const totalWidth =
    COLUMN_WIDTHS.description +
    COLUMN_WIDTHS.ioPoint +
    (showStateColumn ? COLUMN_WIDTHS.state : 0) +
    (showResultColumn ? COLUMN_WIDTHS.result : 0) +
    (showTimestampColumn ? COLUMN_WIDTHS.timestamp : 0) +
    COLUMN_WIDTHS.comments +
    COLUMN_WIDTHS.history +
    COLUMN_WIDTHS.help +
    COLUMN_WIDTHS.failed +
    COLUMN_WIDTHS.clear +
    COLUMN_WIDTHS.output

  return (
    <>
    <Card className="overflow-hidden">
      {/* Search Header */}
      <div className="p-3 sm:p-4 border-b bg-muted/50">
        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <div className="flex flex-wrap gap-2 pl-10 pr-10 py-2 border rounded-md bg-background min-h-[42px] items-center">
            {filterTags.map((tag, index) => (
              <Badge 
                key={index} 
                variant="secondary" 
                className="gap-1 pr-1 text-xs font-normal"
              >
                {tag}
                <button
                  onClick={() => removeFilterTag(tag)}
                  className="ml-1 hover:bg-muted-foreground/20 rounded-full p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <input
              type="text"
              placeholder={filterTags.length === 0 ? "Type and press Space/Enter to add filters..." : "Add filter..."}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 outline-none bg-transparent min-w-[120px] sm:min-w-[200px] text-sm"
            />
          </div>
          {(filterTags.length > 0 || searchTerm) && (
            <button
              onClick={clearAllFilters}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title="Clear all filters"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="text-xs sm:text-sm text-muted-foreground mt-2">
          {filterTags.length > 0 || searchTerm ? (
            <>Found {filteredIos.length} IO{filteredIos.length !== 1 ? 's' : ''} • {filterTags.length} filter{filterTags.length !== 1 ? 's' : ''} active</>
          ) : (
            <>Showing {filteredIos.length} of {ios.length} IO{ios.length !== 1 ? 's' : ''}</>
          )}
        </p>
      </div>

      {/* Data Grid with Virtual Scrolling */}
      <div 
        ref={parentRef}
        className="max-h-[calc(100vh-16rem)] overflow-auto"
      >
        <div style={{ minWidth: `${totalWidth}px` }}>
          {/* Header */}
          <div className="bg-muted sticky top-0 z-10 flex border-b">
            <div 
              className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.description}px` }}
            >
              Description
            </div>
            <div 
              className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.ioPoint}px` }}
            >
              I/O Point
            </div>
            {showStateColumn && (
              <div 
                className="px-3 py-3 text-center text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
                style={{ width: `${COLUMN_WIDTHS.state}px` }}
              >
                State
              </div>
            )}
            {showResultColumn && (
              <div 
                className="px-3 py-3 text-center text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
                style={{ width: `${COLUMN_WIDTHS.result}px` }}
              >
                Result
              </div>
            )}
            {showTimestampColumn && (
              <div 
                className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
                style={{ width: `${COLUMN_WIDTHS.timestamp}px` }}
              >
                Timestamp
              </div>
            )}
            <div 
              className="px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.comments}px` }}
            >
              Comments
            </div>
            <div
              className="px-3 py-3 text-center text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.history}px` }}
            >
              History
            </div>
            <div
              className="px-3 py-3 text-center text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.help}px` }}
            >
              Help
            </div>
            <div
              className="px-3 py-3 text-center text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.failed}px` }}
            >
              Failed
            </div>
            <div 
              className="px-3 py-3 text-center text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.clear}px` }}
            >
              Clear
            </div>
            <div 
              className="px-3 py-3 text-center text-xs font-medium text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.output}px` }}
            >
              Output
            </div>
          </div>

          {/* Virtual Body */}
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const io = filteredIos[virtualRow.index]
              return (
                <div
                  key={io.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className={cn(
                    "hover:bg-muted/50 transition-colors border-b border-border absolute left-0 w-full flex",
                    isTesting ? "cursor-pointer" : "cursor-default",
                    getRowClassName(io),
                    currentTestIo?.id === io.id && "border-l-4 border-l-primary"
                  )}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onClick={() => isTesting && onRowClick?.(io)}
                >
                   <div 
                     className="px-3 py-3 text-xs sm:text-sm flex-shrink-0 flex items-center"
                     style={{ width: `${COLUMN_WIDTHS.description}px` }}
                   >
                     <div className="break-words">
                       {io.description || 'N/A'}
                     </div>
                   </div>
                   <div 
                     className="px-3 py-3 text-xs sm:text-sm font-mono flex-shrink-0 overflow-hidden flex items-center"
                     style={{ width: `${COLUMN_WIDTHS.ioPoint}px` }}
                   >
                     <div className="truncate">{io.name}</div>
                   </div>
                  {showStateColumn && (
                    <div 
                      className="px-3 py-3 text-xs sm:text-sm flex items-center justify-center flex-shrink-0"
                      style={{ width: `${COLUMN_WIDTHS.state}px` }}
                    >
                      {getStateDisplay(io.state)}
                    </div>
                  )}
                   {showResultColumn && (
                     <div 
                       className="px-3 py-3 text-xs sm:text-sm flex items-center justify-center flex-shrink-0"
                       style={{ width: `${COLUMN_WIDTHS.result}px` }}
                     >
                       {io.result ? (
                         <Badge variant={getResultBadgeVariant(io.result)} className="text-xs">
                           {io.result}
                         </Badge>
                       ) : (
                         <Badge variant="secondary" className="text-xs">N/A</Badge>
                       )}
                     </div>
                   )}
                  {showTimestampColumn && (
                    <div 
                      className="px-3 py-3 text-xs sm:text-sm text-muted-foreground flex-shrink-0 flex items-center"
                      style={{ width: `${COLUMN_WIDTHS.timestamp}px` }}
                    >
                      <div className="break-words">{formatTimestamp(io.timestamp) || 'N/A'}</div>
                    </div>
                  )}
                   <div 
                     className="px-3 py-3 text-xs sm:text-sm flex-shrink-0 overflow-hidden flex items-center"
                     style={{ width: `${COLUMN_WIDTHS.comments}px` }}
                   >
                     <div className="truncate" title={io.comments || ''}>
                       {io.comments || '-'}
                     </div>
                   </div>
                  {/* History Column */}
                  <div
                    className="px-3 py-3 text-xs sm:text-sm flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.history}px` }}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleShowHistory(io)
                      }}
                      title="Show History"
                    >
                      <History className="h-3 w-3" />
                    </Button>
                  </div>
                  {/* Help Column - shown for failed IOs with tagType */}
                  <div
                    className="px-3 py-3 text-xs sm:text-sm flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.help}px` }}
                  >
                    {io.result === TEST_CONSTANTS.RESULT_FAILED && io.tagType ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleShowDiagnostic(io)
                        }}
                        title="Show Troubleshooting Guide"
                      >
                        <HelpCircle className="h-4 w-4" />
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </div>
                  {/* Failed Column */}
                  <div 
                    className="px-3 py-3 text-xs sm:text-sm flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.failed}px` }}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        onMarkFailed?.(io)
                      }}
                      disabled={!isTesting}
                      title="Mark as Failed"
                    >
                      <AlertTriangle className="h-3 w-3" />
                    </Button>
                  </div>
                  {/* Clear Column */}
                  <div 
                    className="px-3 py-3 text-xs sm:text-sm flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.clear}px` }}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        onClearResult?.(io)
                      }}
                      disabled={!isTesting || !io.result}
                      title="Clear Result"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  {/* Output Column */}
                  <div 
                    className="px-3 py-3 text-xs sm:text-sm flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.output}px` }}
                  >
                    {isOutput(io.name) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(e) => {
                          e.stopPropagation()
                          onShowFireOutputDialog?.(io)
                        }}
                        disabled={!isTesting}
                        title="Fire Output"
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                    ) : (
                      <X className="h-3 w-3 text-muted-foreground" />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {filteredIos.length === 0 && (
        <div className="p-8 text-left text-muted-foreground">
          <p>No IOs found matching your filters.</p>
          {(filterTags.length > 0 || searchTerm) && (
            <Button 
              variant="link" 
              onClick={clearAllFilters}
              className="mt-2"
            >
              Clear all filters
            </Button>
          )}
        </div>
      )}
    </Card>

    {selectedIo && (
      <TestHistoryDialog
        open={showHistoryDialog}
        onOpenChange={setShowHistoryDialog}
        ioName={selectedIo.name}
        ioDescription={selectedIo.description}
        history={loadingHistory ? [] : historyData}
      />
    )}

    {diagnosticIo && diagnosticIo.tagType && (
      <DiagnosticStepsDialog
        open={showDiagnosticDialog}
        onOpenChange={setShowDiagnosticDialog}
        tagType={diagnosticIo.tagType}
        failureMode={diagnosticIo.failureMode || 'No response'}
        tagName={diagnosticIo.name}
      />
    )}
  </>
  )
}