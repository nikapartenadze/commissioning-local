"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TestHistoryDialog } from "@/components/test-history-dialog"
import { formatTimestamp, getResultBadgeVariant } from "@/lib/utils"
import { TEST_CONSTANTS } from "@/lib/constants"
import { Search, History, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { API_ENDPOINTS } from "@/lib/api-config"

type IoItem = {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  subsystemName: string
}

type TestHistory = {
  id: number
  result: string | null
  state: string | null
  comments: string | null
  testedBy: string | null
  timestamp: string
}

interface IoDataGridProps {
  ios: IoItem[]
  projectId: number
  onFilteredDataChange?: (filteredIos: IoItem[]) => void
}

export function IoDataGrid({ ios, projectId, onFilteredDataChange }: IoDataGridProps) {
  const [searchTerm, setSearchTerm] = useState("")
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [selectedIo, setSelectedIo] = useState<IoItem | null>(null)
  const [showHistoryDialog, setShowHistoryDialog] = useState(false)
  const [historyData, setHistoryData] = useState<TestHistory[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)

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
      // Remove last tag when backspace on empty input
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
      
      // OR logic: IO matches if it contains ANY of the filter terms
      // This allows: "Local" OR "RCP" OR "06/07" OR "07/24" etc.
      return allTerms.some(term => {
        const lowerTerm = term.toLowerCase()
        return (
          io.name?.toLowerCase().includes(lowerTerm) ||
          io.description?.toLowerCase().includes(lowerTerm) ||
          io.subsystemName?.toLowerCase().includes(lowerTerm) ||
          io.comments?.toLowerCase().includes(lowerTerm) ||
          io.timestamp?.toLowerCase().includes(lowerTerm)
        )
      })
    })
    return filtered
  }, [ios, filterTags, searchTerm])

  // Notify parent when filtered data changes (for chart update)
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
    estimateSize: () => 60, // Estimated row height
    overscan: 10, // Render 10 extra rows above/below viewport
  })

  const getRowClassName = (result: string | null) => {
    if (result === TEST_CONSTANTS.RESULT_PASSED) return "row-passed"
    if (result === TEST_CONSTANTS.RESULT_FAILED) return "row-failed"
    return "row-default"
  }

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
        className="max-h-[calc(100vh-16rem)] overflow-y-auto overflow-x-auto"
      >
        <table className="w-full min-w-[800px] sm:min-w-full table-fixed">
          <thead className="bg-muted sticky top-0 z-10">
            <tr>
              <th className="px-2 sm:px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase w-[20%] min-w-[120px]">
                Description
              </th>
              <th className="px-2 sm:px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase w-[18%] min-w-[100px]">
                I/O Point
              </th>
              <th className="px-2 sm:px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase w-[9%] min-w-[80px]">
                Subsystem
              </th>
              <th className="px-2 sm:px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase w-[9%] min-w-[80px]">
                Result
              </th>
              <th className="px-2 sm:px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase w-[14%] min-w-[100px]">
                Timestamp
              </th>
              <th className="px-2 sm:px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase w-[22%] min-w-[120px]">
                Comments
              </th>
              <th className="px-2 sm:px-3 py-3 text-center text-xs font-medium text-muted-foreground uppercase w-[8%] min-w-[60px]">
                History
              </th>
            </tr>
          </thead>
          <tbody 
            className="bg-background"
            style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const io = filteredIos[virtualRow.index]
              return (
                <tr
                  key={io.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className={cn(
                    "hover:bg-muted/50 transition-colors border-b border-border absolute w-full left-0 flex",
                    getRowClassName(io.result)
                  )}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <td className="px-2 sm:px-3 py-3 text-xs sm:text-sm" style={{ width: '20%' }}>
                    <div className="break-words" title={io.description || ''}>
                      {io.description || '-'}
                    </div>
                  </td>
                  <td className="px-2 sm:px-3 py-3 text-xs sm:text-sm font-mono" style={{ width: '18%' }}>
                    <div className="break-all">{io.name}</div>
                  </td>
                  <td className="px-2 sm:px-3 py-3 text-xs sm:text-sm" style={{ width: '9%' }}>
                    <Badge variant="outline" className="text-xs">
                      {io.subsystemName}
                    </Badge>
                  </td>
                  <td className="px-2 sm:px-3 py-3 text-xs sm:text-sm" style={{ width: '9%' }}>
                    {io.result ? (
                      <Badge variant={getResultBadgeVariant(io.result)} className="text-xs">
                        {io.result}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">Not Tested</Badge>
                    )}
                  </td>
                  <td className="px-2 sm:px-3 py-3 text-xs sm:text-sm text-muted-foreground" style={{ width: '14%' }}>
                    <div className="break-words">{formatTimestamp(io.timestamp)}</div>
                  </td>
                  <td className="px-2 sm:px-3 py-3 text-xs sm:text-sm" style={{ width: '22%' }}>
                    <div className="break-words" title={io.comments || ''}>
                      {io.comments || '-'}
                    </div>
                  </td>
                  <td className="px-2 sm:px-3 py-3 text-xs sm:text-sm text-center" style={{ width: '8%' }}>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-7 w-7 sm:h-8 sm:w-8"
                      onClick={() => handleShowHistory(io)}
                    >
                      <History className="h-3 w-3 sm:h-4 sm:w-4" />
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {filteredIos.length === 0 && (
        <div className="p-8 text-center text-muted-foreground">
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
  </>
  )
}

