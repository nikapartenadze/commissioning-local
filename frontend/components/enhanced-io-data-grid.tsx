"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TestHistoryDialog } from "@/components/test-history-dialog"
import { DiagnosticStepsDialog } from "@/components/diagnostic-steps-dialog"
import { formatTimestamp, getResultBadgeVariant } from "@/lib/utils"
import { TEST_CONSTANTS } from "@/lib/constants"
import { Search, History, X, Play, AlertTriangle, HelpCircle, FileEdit } from "lucide-react"
import { cn } from "@/lib/utils"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"

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
  assignedTo?: string | null
  networkDeviceName?: string | null
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
  onCommentChange?: (io: IoItem, comment: string) => void
  activeQuickFilter?: 'failed' | 'not-tested' | 'passed' | 'inputs' | 'outputs' | 'my-ios' | null
  punchlists?: Array<{ id: number; name: string; ioIds: number[] }>
  activePunchlistId?: number | null
  onRequestChange?: (io: IoItem) => void
  currentUser?: { fullName: string; isAdmin: boolean } | null
  faultedDevices?: Set<string>
  deviceStatuses?: Map<string, 'green' | 'red' | 'gray'>
}

// Column widths — responsive via hook
function useColumnWidths() {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setIsMobile(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isMobile ? {
    description: 180,
    ioPoint: 160,
    state: 60,
    deviceStatus: 60,
    result: 80,
    timestamp: 0, // hidden on mobile
    comments: 0,  // hidden on mobile
    history: 50,
    help: 50,
    failed: 50,
    clear: 50,
    output: 80,
  } : {
    description: 320,
    ioPoint: 260,
    state: 100,
    deviceStatus: 90,
    result: 120,
    timestamp: 180,
    comments: 220,
    history: 70,
    help: 70,
    failed: 70,
    clear: 70,
    output: 100,
  }
}

// Row height for better touch targets
const ROW_HEIGHT = 56

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
  onShowFireOutputDialog,
  onCommentChange,
  activeQuickFilter = null,
  punchlists,
  activePunchlistId,
  onRequestChange,
  currentUser,
  faultedDevices = new Set(),
  deviceStatuses = new Map()
}: EnhancedIoDataGridProps) {
  const [searchTerm, setSearchTerm] = useState("")
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [selectedIo, setSelectedIo] = useState<IoItem | null>(null)
  const [showHistoryDialog, setShowHistoryDialog] = useState(false)
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null)
  const [editingCommentValue, setEditingCommentValue] = useState("")
  const [historyData, setHistoryData] = useState<TestHistory[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [showStateColumn, setShowStateColumn] = useState(true)
  const [showResultColumn, setShowResultColumn] = useState(true)
  const [showTimestampColumn, setShowTimestampColumn] = useState(true)
  const [sortMode, setSortMode] = useState<'default' | 'failed-first' | 'not-tested-first'>('default')
  const [showDiagnosticDialog, setShowDiagnosticDialog] = useState(false)
  const [diagnosticIo, setDiagnosticIo] = useState<IoItem | null>(null)
  const [moduleHealth, setModuleHealth] = useState<Record<string, 'ok' | 'warning' | 'error'>>({})
  const [activeKeywordFilters, setActiveKeywordFilters] = useState<Record<string, 'include' | 'exclude'>>({})
  const [assignMode, setAssignMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [users, setUsers] = useState<{ id: number; fullName: string }[]>([])
  const [assignTarget, setAssignTarget] = useState<string>('')
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null)
  const [assignKeywordInput, setAssignKeywordInput] = useState('')
  const [showAssignKeywordInput, setShowAssignKeywordInput] = useState(false)
  const COLUMN_WIDTHS = useColumnWidths()

  // Fetch module health status periodically
  useEffect(() => {
    const fetchModuleHealth = async () => {
      try {
        const response = await authFetch(API_ENDPOINTS.networkModules)
        if (response.ok) {
          const data = await response.json()
          const healthMap: Record<string, 'ok' | 'warning' | 'error'> = {}
          if (data.modules) {
            for (const mod of data.modules) {
              healthMap[mod.name] = mod.status as 'ok' | 'warning' | 'error'
            }
          }
          setModuleHealth(healthMap)
        }
      } catch {
        // Silently fail - module health is non-critical
      }
    }

    fetchModuleHealth()
  }, [])

  // Fetch users when assign mode is activated
  useEffect(() => {
    if (!assignMode) return
    const fetchUsers = async () => {
      try {
        const response = await authFetch('/api/users')
        if (response.ok) {
          const data = await response.json()
          setUsers(data.filter((u: { isActive: boolean }) => u.isActive))
        }
      } catch { /* ignore */ }
    }
    fetchUsers()
  }, [assignMode])

  // Clear selection when leaving assign mode
  useEffect(() => {
    if (!assignMode) {
      setSelectedIds(new Set())
      setShowAssignKeywordInput(false)
    }
  }, [assignMode])

  const toggleSelection = (ioId: number, index: number, shiftKey: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (shiftKey && lastClickedIndex !== null) {
        const start = Math.min(lastClickedIndex, index)
        const end = Math.max(lastClickedIndex, index)
        for (let i = start; i <= end; i++) {
          next.add(filteredIos[i].id)
        }
      } else {
        if (next.has(ioId)) next.delete(ioId)
        else next.add(ioId)
      }
      return next
    })
    setLastClickedIndex(index)
  }

  const handleAssign = async () => {
    if (selectedIds.size === 0 || !assignTarget) return
    try {
      const response = await authFetch('/api/ios/assign', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ioIds: Array.from(selectedIds), assignedTo: assignTarget }),
      })
      if (response.ok) {
        // Trigger a re-fetch by reloading — parent handles data
        window.location.reload()
      }
    } catch { /* ignore */ }
  }

  const handleUnassign = async () => {
    if (selectedIds.size === 0) return
    try {
      const response = await authFetch('/api/ios/assign', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ioIds: Array.from(selectedIds), assignedTo: null }),
      })
      if (response.ok) {
        window.location.reload()
      }
    } catch { /* ignore */ }
  }

  const selectByKeyword = () => {
    if (!assignKeywordInput.trim()) return
    const kw = assignKeywordInput.trim().toLowerCase()
    const matchingIds = filteredIos
      .filter(io => (io.name?.toLowerCase().includes(kw) || io.description?.toLowerCase().includes(kw)))
      .map(io => io.id)
    setSelectedIds(prev => {
      const next = new Set(prev)
      matchingIds.forEach(id => next.add(id))
      return next
    })
    setAssignKeywordInput('')
    setShowAssignKeywordInput(false)
  }

  // Extract module name from IO name (prefix before ':')
  const getModuleName = (ioName: string): string | null => {
    const colonIndex = ioName.indexOf(':')
    return colonIndex > 0 ? ioName.substring(0, colonIndex) : null
  }

  // Extract device name from tag name (same logic as commissioning page)
  const extractDeviceName = (tagName: string | null | undefined): string | null => {
    if (!tagName) return null
    const colonIdx = tagName.indexOf(':')
    if (colonIdx > 0) return tagName.substring(0, colonIdx)
    const fiomMatch = tagName.match(/^(.+?)_X\d/)
    if (fiomMatch) return fiomMatch[1]
    const dotIdx = tagName.indexOf('.')
    if (dotIdx > 0) return tagName.substring(0, dotIdx)
    return tagName
  }

  const handleShowHistory = async (io: IoItem) => {
    setSelectedIo(io)
    setLoadingHistory(true)
    setShowHistoryDialog(true)
    
    try {
      const response = await authFetch(API_ENDPOINTS.ioHistory(io.id))
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

  // Auto-detect keyword filters from IO descriptions only
  const keywordFilters = useMemo(() => {
    if (ios.length === 0) return []

    // Common industrial keywords to look for in descriptions
    const KEYWORDS = [
      'SPARE',
      'VFD', 'DISCONNECT', 'AUX',
      'MOTOR', 'PHOTO', 'PROX', 'SAFETY',
      'TRACKING', 'SIO', 'FIOM', 'PMM',
      'PE', 'LPE', 'TPE', 'FPE',
    ]

    // Count occurrences in descriptions only
    const counts: Record<string, number> = {}
    for (const io of ios) {
      const desc = (io.description || '').toUpperCase()
      if (!desc) continue
      for (const kw of KEYWORDS) {
        if (desc.includes(kw)) {
          counts[kw] = (counts[kw] || 0) + 1
        }
      }
    }

    // Only include keywords that match at least 2 IOs
    const result = Object.entries(counts)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([keyword, count]) => ({ keyword, count }))

    return result
  }, [ios])

  const toggleKeywordFilter = (keyword: string) => {
    setActiveKeywordFilters(prev => {
      const current = prev[keyword]
      const next = { ...prev }
      if (!current) {
        next[keyword] = 'include'
      } else if (current === 'include') {
        next[keyword] = 'exclude'
      } else {
        delete next[keyword]
      }
      return next
    })
  }

  // Clean up stale keyword filters when available keywords change (e.g., after pulling different subsystem)
  useEffect(() => {
    const availableKeywords = new Set(keywordFilters.map(kf => kf.keyword))
    setActiveKeywordFilters(prev => {
      const keys = Object.keys(prev)
      if (keys.length === 0) return prev
      const cleaned: Record<string, 'include' | 'exclude'> = {}
      let changed = false
      for (const k of keys) {
        if (availableKeywords.has(k)) {
          cleaned[k] = prev[k]
        } else {
          changed = true
        }
      }
      return changed ? cleaned : prev
    })
  }, [keywordFilters])

  // Pre-compute punchlist IO set for fast lookup
  const punchlistIoSet = useMemo(() => {
    if (!activePunchlistId || !punchlists) return null
    const punchlist = punchlists.find(p => p.id === activePunchlistId)
    return punchlist ? new Set(punchlist.ioIds) : null
  }, [activePunchlistId, punchlists])

  const filteredIos = useMemo(() => {
    const filtered = ios.filter(io => {
      // Hide SPAREs unless failed or explicitly filtered by SPARE keyword
      const isSpare = io.description?.toUpperCase().includes('SPARE')
      if (isSpare && io.result !== 'Failed' && !activeKeywordFilters['SPARE']) return false

      // Punchlist filter — if active, only show IOs in this punchlist
      if (punchlistIoSet && !punchlistIoSet.has(io.id)) return false

      // Apply quick filter first
      if (activeQuickFilter === 'failed' && io.result !== 'Failed') return false
      if (activeQuickFilter === 'not-tested' && io.result) return false
      if (activeQuickFilter === 'passed' && io.result !== 'Passed') return false
      if (activeQuickFilter === 'outputs') {
        const name = io.name || ''
        if (!(name.includes(':O.') || name.includes(':SO.'))) return false
      }
      if (activeQuickFilter === 'inputs') {
        const name = io.name || ''
        if (name.includes(':O.') || name.includes(':SO.')) return false
      }
      if (activeQuickFilter === 'my-ios') {
        if (!currentUser?.fullName || io.assignedTo !== currentUser.fullName) return false
      }

      // Apply keyword filters on description — include (AND): must match ALL; exclude: must match NONE
      const activeEntries = Object.entries(activeKeywordFilters)
      if (activeEntries.length > 0) {
        const desc = (io.description || '').toUpperCase()
        const includes = activeEntries.filter(([, mode]) => mode === 'include')
        const excludes = activeEntries.filter(([, mode]) => mode === 'exclude')
        if (includes.length > 0 && !includes.every(([kw]) => desc.includes(kw))) return false
        if (excludes.length > 0 && excludes.some(([kw]) => desc.includes(kw))) return false
      }

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

    if (sortMode === 'default') return filtered

    const sortOrder = (result: string | null): number => {
      if (sortMode === 'failed-first') {
        if (result === 'Failed') return 0
        if (!result) return 1
        return 2
      }
      // not-tested-first
      if (!result) return 0
      if (result === 'Failed') return 1
      return 2
    }

    return [...filtered].sort((a, b) => sortOrder(a.result) - sortOrder(b.result))
  }, [ios, filterTags, searchTerm, activeQuickFilter, activeKeywordFilters, sortMode, punchlistIoSet])

  useEffect(() => {
    if (onFilteredDataChange) {
      onFilteredDataChange(filteredIos)
    }
  }, [filteredIos, onFilteredDataChange])

  // Virtual scrolling setup
  const parentRef = useRef<HTMLDivElement>(null)

  // Drag-to-scroll state
  const [isDragging, setIsDragging] = useState(false)
  const [startX, setStartX] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!parentRef.current) return
    // Don't start drag if clicking on interactive elements or text content
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    if (target.closest('input')) return
    // Allow text selection in data cells
    if (target.closest('[data-selectable]')) return
    setIsDragging(true)
    setStartX(e.pageX - parentRef.current.offsetLeft)
    setScrollLeft(parentRef.current.scrollLeft)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !parentRef.current) return
    e.preventDefault()
    const x = e.pageX - parentRef.current.offsetLeft
    const walk = (x - startX) * 1.5 // Scroll speed multiplier
    parentRef.current.scrollLeft = scrollLeft - walk
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleMouseLeave = () => {
    setIsDragging(false)
  }

  const virtualizer = useVirtualizer({
    count: filteredIos.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  const getRowClassName = (io: IoItem) => {
    if (io.result === TEST_CONSTANTS.RESULT_PASSED) return "row-passed"
    if (io.result === TEST_CONSTANTS.RESULT_FAILED) return "row-failed"
    if (currentTestIo?.id === io.id) return "row-current-test"
    return "row-default"
  }

  const getStateDisplay = (state: string | null) => {
    if (!state || state === 'UNKNOWN') {
      return <div className="w-6 h-6 rounded-full bg-gray-300 dark:bg-gray-600" />
    }

    if (state === 'TRUE' || state === 'ON' || state === 'HIGH' || state === 'ACTIVE' || state === '1') {
      return <div className="w-6 h-6 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
    }
    if (state === 'FALSE' || state === 'OFF' || state === 'LOW' || state === 'INACTIVE' || state === '0') {
      return <div className="w-6 h-6 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
    }

    return <div className="w-6 h-6 rounded-full bg-gray-300 dark:bg-gray-600" />
  }

  // Match backend Io.IsOutput property - check for O after colon before dot
  const isOutput = (ioName: string) =>
    ioName.includes(':O.') ||
    ioName.includes(':SO.') ||   // Safety Output - cannot be fired directly
    ioName.includes('.O.') ||
    ioName.includes(':O:') ||
    ioName.includes('.Outputs.') ||
    ioName.endsWith('.DO') ||
    ioName.endsWith('_DO')

  // Safety outputs cannot be written - they're controlled by safety PLC
  const isSafetyOutput = (ioName: string) => ioName.includes(':SO.')

  const handleShowDiagnostic = async (io: IoItem) => {
    // If IO doesn't have failureMode, fetch it from history
    if (!io.failureMode && io.id) {
      try {
        const response = await authFetch(API_ENDPOINTS.ioHistory(io.id))
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
  const showTimestamp = showTimestampColumn && COLUMN_WIDTHS.timestamp > 0
  const showComments = COLUMN_WIDTHS.comments > 0
  const totalWidth =
    COLUMN_WIDTHS.description +
    COLUMN_WIDTHS.ioPoint +
    (showStateColumn ? COLUMN_WIDTHS.state : 0) +
    COLUMN_WIDTHS.deviceStatus +
    (showResultColumn ? COLUMN_WIDTHS.result : 0) +
    (showTimestamp ? COLUMN_WIDTHS.timestamp : 0) +
    (showComments ? COLUMN_WIDTHS.comments : 0) +
    COLUMN_WIDTHS.history +
    COLUMN_WIDTHS.help +
    COLUMN_WIDTHS.failed +
    COLUMN_WIDTHS.clear +
    COLUMN_WIDTHS.output

  return (
    <>
    <div className="h-full flex flex-col border-t border-border bg-card">
      {/* Compact Search Bar */}
      <div data-tour="search-area" className="flex items-center gap-2 p-2 border-b bg-muted/30 flex-shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <div className="flex flex-wrap gap-1 pl-10 pr-10 py-2 border rounded bg-background min-h-[44px] items-center">
            {filterTags.map((tag, index) => (
              <Badge
                key={index}
                variant="secondary"
                className="gap-1 pr-1 text-sm font-medium"
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
              placeholder={filterTags.length === 0 ? "Search IO points..." : ""}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 outline-none bg-transparent min-w-[60px] sm:min-w-[150px] text-sm sm:text-base"
            />
          </div>
          {(filterTags.length > 0 || searchTerm) && (
            <button
              onClick={clearAllFilters}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
              title="Clear"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Sort dropdown removed — Pass/Fail filters in toolbar serve the same purpose */}

        {/* Count Badge */}
        <div className="h-[44px] px-4 flex items-center bg-muted rounded font-mono text-sm whitespace-nowrap">
          <span className="font-bold">{filteredIos.length}</span>
          <span className="text-muted-foreground ml-1">/ {ios.length}</span>
        </div>

        {/* Assign Mode Toggle — disabled for now
        {currentUser?.isAdmin && (
          <button
            onClick={() => setAssignMode(!assignMode)}
            className={cn(
              "h-[44px] px-3 text-sm rounded font-medium whitespace-nowrap border",
              assignMode
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-accent"
            )}
          >
            {assignMode ? 'Exit Assign' : 'Assign'}
          </button>
        )}
        */}
      </div>

      {/* Keyword Filter Pills */}
      {keywordFilters.length > 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b bg-muted/20 flex-shrink-0 overflow-x-auto">
          <span className="text-[10px] text-[#C6941A] uppercase tracking-wider font-semibold shrink-0">Filter:</span>
          {keywordFilters.map(({ keyword, count }) => {
            const mode = activeKeywordFilters[keyword]
            return (
              <button
                key={keyword}
                onClick={() => toggleKeywordFilter(keyword)}
                className={cn(
                  "px-2 py-0.5 rounded-full text-xs font-medium transition-colors shrink-0",
                  mode === 'include'
                    ? "bg-primary text-primary-foreground"
                    : mode === 'exclude'
                    ? "bg-destructive text-destructive-foreground line-through"
                    : "bg-muted border border-[#C6941A]/20 hover:border-[#C6941A]/50 text-muted-foreground hover:text-foreground"
                )}
                title={mode === 'include' ? 'Showing only — click to exclude' : mode === 'exclude' ? 'Excluding — click to clear' : 'Click to include, click again to exclude'}
              >
                {mode === 'exclude' && <span className="mr-0.5">-</span>}
                {keyword}
                <span className="ml-1 opacity-60">{count}</span>
              </button>
            )
          })}
          {Object.keys(activeKeywordFilters).length > 0 && (
            <button
              onClick={() => setActiveKeywordFilters({})}
              className="px-2 py-0.5 rounded-full text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Data Grid with Virtual Scrolling */}
      <div
        data-tour="io-grid"
        ref={parentRef}
        className={cn(
          "flex-1 overflow-auto grab-scroll min-h-0",
          isDragging && "dragging"
        )}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >
        <div style={{ minWidth: `${totalWidth}px` }}>
          {/* Header - Sticky, bold, industrial */}
          <div className="bg-muted sticky top-0 z-10 flex border-b-2 border-[#C6941A]/40">
            <div
              className="px-4 py-3 text-left text-sm font-bold text-foreground uppercase tracking-wide flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.description}px` }}
            >
              Description
            </div>
            <div
              className="px-4 py-3 text-left text-sm font-bold text-foreground uppercase tracking-wide flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.ioPoint}px` }}
            >
              I/O Point
            </div>
            {showStateColumn && (
              <div
                className="px-4 py-3 text-center text-sm font-bold text-foreground uppercase tracking-wide flex-shrink-0"
                style={{ width: `${COLUMN_WIDTHS.state}px` }}
              >
                State
              </div>
            )}
            <div
              className="px-2 py-3 text-center text-xs font-bold text-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.deviceStatus}px` }}
            >
              Net Device
            </div>
            {showResultColumn && (
              <div
                className="px-4 py-3 text-center text-sm font-bold text-foreground uppercase tracking-wide flex-shrink-0"
                style={{ width: `${COLUMN_WIDTHS.result}px` }}
              >
                Result
              </div>
            )}
            {showTimestamp && (
              <div
                className="px-4 py-3 text-left text-sm font-bold text-foreground uppercase tracking-wide flex-shrink-0"
                style={{ width: `${COLUMN_WIDTHS.timestamp}px` }}
              >
                Tested
              </div>
            )}
            {showComments && (
            <div
              className="px-4 py-3 text-left text-sm font-bold text-foreground uppercase tracking-wide flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.comments}px` }}
            >
              Notes
            </div>
            )}
            <div
              className="px-2 py-3 text-center text-xs font-bold text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.history}px` }}
            >
              Hist
            </div>
            <div
              className="px-2 py-3 text-center text-xs font-bold text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.help}px` }}
            >
              Help
            </div>
            <div
              className="px-2 py-3 text-center text-xs font-bold text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.failed}px` }}
            >
              Fail
            </div>
            <div
              className="px-2 py-3 text-center text-xs font-bold text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.clear}px` }}
            >
              Clear
            </div>
            <div
              className="px-2 py-3 text-center text-xs font-bold text-muted-foreground uppercase flex-shrink-0"
              style={{ width: `${COLUMN_WIDTHS.output}px` }}
            >
              Fire
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
              // Only show device status for IOs with a matching network topology device
              const rowDeviceName = (io as any).hasNetworkDevice ? io.networkDeviceName : null
              const deviceStatus = rowDeviceName ? deviceStatuses.get(rowDeviceName) : undefined
              const isDeviceFaulted = deviceStatus === 'red'
              return (
                <div
                  key={io.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className={cn(
                    "transition-colors border-b border-border absolute left-0 w-full flex group",
                    isTesting ? "cursor-pointer" : "cursor-default",
                    getRowClassName(io),
                    currentTestIo?.id === io.id && "border-l-4 border-l-primary",
                    isDeviceFaulted && "opacity-50 pointer-events-none select-none"
                  )}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onClick={() => {
                    if (assignMode) {
                      toggleSelection(io.id, virtualRow.index, false)
                    } else if (isTesting) {
                      onRowClick?.(io)
                    }
                  }}
                >
                   {/* Assign mode checkbox */}
                   {assignMode && (
                     <div
                       className="w-10 flex items-center justify-center flex-shrink-0"
                       onClick={(e) => {
                         e.stopPropagation()
                         toggleSelection(io.id, virtualRow.index, e.shiftKey)
                       }}
                     >
                       <input
                         type="checkbox"
                         checked={selectedIds.has(io.id)}
                         onChange={() => {}}
                         className="h-5 w-5 accent-primary cursor-pointer"
                       />
                     </div>
                   )}
                   <div
                     className="px-4 py-2 text-sm font-medium flex-shrink-0 flex items-center select-text"
                     style={{ width: `${COLUMN_WIDTHS.description}px` }}
                     data-selectable
                   >
                     <div className="line-clamp-2 leading-tight flex-1">
                       {io.description || <span className="text-muted-foreground">—</span>}
                     </div>
                     {isDeviceFaulted && (
                       <span className="ml-2 text-[10px] text-red-500 font-medium shrink-0">DEVICE FAULTED</span>
                     )}
                     {!isTesting && onRequestChange && (
                       <button
                         className="ml-1 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                         onClick={(e) => { e.stopPropagation(); onRequestChange(io) }}
                         title="Request change"
                       >
                         <FileEdit className="h-3.5 w-3.5" />
                       </button>
                     )}
                   </div>
                   <div
                     className="px-4 py-2 text-sm font-mono font-medium flex-shrink-0 overflow-hidden flex items-center gap-2 select-text"
                     style={{ width: `${COLUMN_WIDTHS.ioPoint}px` }}
                     data-selectable
                   >
                     {/* Module health indicator */}
                     {(() => {
                       const modName = getModuleName(io.name)
                       const health = modName ? moduleHealth[modName] : undefined
                       if (!health) return null
                       return (
                         <div
                           className={cn(
                             "w-3 h-3 rounded-full shrink-0",
                             health === 'ok' && "bg-green-500",
                             health === 'warning' && "bg-yellow-500 status-pulse",
                             health === 'error' && "bg-red-500 status-pulse"
                           )}
                           title={`Module ${modName}: ${health}`}
                         />
                       )
                     })()}
                     <div className="truncate">{io.name}</div>
                     {io.assignedTo && (
                       <span
                         className="ml-1 shrink-0 inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary text-[10px] font-bold uppercase"
                         title={`Assigned to ${io.assignedTo}`}
                       >
                         {io.assignedTo.split(' ').map(w => w[0]).join('').slice(0, 2)}
                       </span>
                     )}
                   </div>
                  {showStateColumn && (
                    <div
                      className="px-4 py-2 flex items-center justify-center flex-shrink-0"
                      style={{ width: `${COLUMN_WIDTHS.state}px` }}
                    >
                      {getStateDisplay(io.state)}
                    </div>
                  )}
                  {/* Network Device Status — same style as State column */}
                  <div
                    className="px-2 py-3 text-center flex-shrink-0 flex items-center justify-center"
                    style={{ width: `${COLUMN_WIDTHS.deviceStatus}px` }}
                  >
                    {rowDeviceName ? (() => {
                      if (deviceStatus === 'red') return <div className="w-6 h-6 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" title={`${rowDeviceName} — FAULTED`} />
                      if (deviceStatus === 'green') return <div className="w-6 h-6 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" title={`${rowDeviceName} — OK`} />
                      return <div className="w-6 h-6 rounded-full bg-gray-300 dark:bg-gray-600" title={`${rowDeviceName} — No PLC data`} />
                    })() : null}
                  </div>
                   {showResultColumn && (
                     <div
                       className="px-4 py-2 flex items-center justify-center flex-shrink-0"
                       style={{ width: `${COLUMN_WIDTHS.result}px` }}
                     >
                       {io.result ? (
                         <Badge variant={getResultBadgeVariant(io.result)} className="text-sm font-bold px-3 py-1">
                           {io.result}
                         </Badge>
                       ) : (
                         <span className="text-muted-foreground text-sm">—</span>
                       )}
                     </div>
                   )}
                  {showTimestamp && (
                    <div
                      className="px-4 py-2 text-sm text-muted-foreground flex-shrink-0 flex items-center font-mono"
                      style={{ width: `${COLUMN_WIDTHS.timestamp}px` }}
                    >
                      {formatTimestamp(io.timestamp) || <span className="opacity-50">—</span>}
                    </div>
                  )}
                   {showComments && (
                   <div
                     className="px-4 py-2 text-sm flex-shrink-0 overflow-hidden flex items-center"
                     style={{ width: `${COLUMN_WIDTHS.comments}px` }}
                     onClick={(e) => e.stopPropagation()}
                   >
                     {editingCommentId === io.id ? (
                       <input
                         type="text"
                         className="w-full px-3 py-2 text-sm border-2 rounded bg-background focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                         value={editingCommentValue}
                         onChange={(e) => setEditingCommentValue(e.target.value)}
                         onBlur={() => {
                           if (editingCommentValue !== (io.comments || '')) {
                             onCommentChange?.(io, editingCommentValue)
                           }
                           setEditingCommentId(null)
                         }}
                         onKeyDown={(e) => {
                           if (e.key === 'Enter') {
                             if (editingCommentValue !== (io.comments || '')) {
                               onCommentChange?.(io, editingCommentValue)
                             }
                             setEditingCommentId(null)
                           } else if (e.key === 'Escape') {
                             setEditingCommentId(null)
                           }
                         }}
                         autoFocus
                       />
                     ) : (
                       <div
                         className="truncate cursor-text hover:bg-muted px-2 py-1 rounded w-full min-h-[32px] flex items-center"
                         title={io.comments ? `${io.comments} (click to edit)` : 'Click to add note'}
                         onClick={() => {
                           setEditingCommentId(io.id)
                           setEditingCommentValue(io.comments || '')
                         }}
                       >
                         {io.comments || <span className="text-muted-foreground">+ Add note</span>}
                       </div>
                     )}
                   </div>
                   )}
                  {/* History Column */}
                  <div
                    className="px-1 py-2 flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.history}px` }}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleShowHistory(io)
                      }}
                      title="History"
                    >
                      <History className="h-5 w-5" />
                    </Button>
                  </div>
                  {/* Help Column */}
                  <div
                    className="px-1 py-2 flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.help}px` }}
                  >
                    {io.tagType ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-10 w-10",
                          io.result === TEST_CONSTANTS.RESULT_FAILED
                            ? "text-red-600 hover:text-red-700 hover:bg-red-100 dark:hover:bg-red-900/30"
                            : "text-amber-600 hover:text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/30"
                        )}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleShowDiagnostic(io)
                        }}
                        title="Help"
                      >
                        <HelpCircle className="h-5 w-5" />
                      </Button>
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </div>
                  {/* Failed Column */}
                  <div
                    className="px-1 py-2 flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.failed}px` }}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 text-red-600 hover:text-red-700 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-30"
                      onClick={(e) => {
                        e.stopPropagation()
                        onMarkFailed?.(io)
                      }}
                      disabled={!isTesting}
                      title="Mark Failed"
                    >
                      <AlertTriangle className="h-5 w-5" />
                    </Button>
                  </div>
                  {/* Clear Column */}
                  <div
                    className="px-1 py-2 flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.clear}px` }}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 disabled:opacity-30"
                      onClick={(e) => {
                        e.stopPropagation()
                        onClearResult?.(io)
                      }}
                      disabled={!io.result}
                      title="Clear"
                    >
                      <X className="h-5 w-5" />
                    </Button>
                  </div>
                  {/* Fire Output Column */}
                  <div
                    className="px-2 py-2 flex items-center justify-center flex-shrink-0"
                    style={{ width: `${COLUMN_WIDTHS.output}px` }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isOutput(io.name) ? (
                      isSafetyOutput(io.name) ? (
                        <span className="text-xs text-muted-foreground/50 px-2" title="Safety outputs cannot be fired directly">
                          SAFETY
                        </span>
                      ) : (
                        <Button
                          variant="default"
                          size="sm"
                          className="h-10 px-3 bg-amber-500 hover:bg-amber-600 text-white font-bold shadow-md disabled:opacity-30 disabled:bg-amber-500/50"
                          onClick={(e) => {
                            e.stopPropagation()
                            onShowFireOutputDialog?.(io)
                          }}
                          title="Fire Output"
                        >
                          <Play className="h-4 w-4 mr-1" />
                          FIRE
                        </Button>
                      )
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {filteredIos.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground p-8">
          <div className="text-center">
            <p className="text-lg">No IOs found matching your filters.</p>
            {(filterTags.length > 0 || searchTerm) && (
              <Button
                variant="outline"
                onClick={clearAllFilters}
                className="mt-4"
              >
                Clear all filters
              </Button>
            )}
          </div>
        </div>
      )}
    </div>

    {selectedIo && (
      <TestHistoryDialog
        open={showHistoryDialog}
        onOpenChange={setShowHistoryDialog}
        ioName={selectedIo.name}
        ioDescription={selectedIo.description}
        history={loadingHistory ? [] : historyData}
      />
    )}

    {/* Assign Mode Bottom Bar */}
    {assignMode && (
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t-2 border-primary shadow-lg px-4 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-bold">{selectedIds.size} selected</span>

        <button
          onClick={() => setShowAssignKeywordInput(!showAssignKeywordInput)}
          className="px-3 py-1.5 text-sm border rounded hover:bg-accent"
        >
          Select by keyword
        </button>

        {showAssignKeywordInput && (
          <div className="flex items-center gap-1">
            <input
              type="text"
              placeholder="e.g. VFD"
              value={assignKeywordInput}
              onChange={(e) => setAssignKeywordInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') selectByKeyword() }}
              className="px-2 py-1.5 text-sm border rounded bg-background w-32"
              autoFocus
            />
            <button onClick={selectByKeyword} className="px-2 py-1.5 text-sm border rounded hover:bg-accent">Go</button>
          </div>
        )}

        <button
          onClick={() => setSelectedIds(new Set(filteredIos.map(io => io.id)))}
          className="px-3 py-1.5 text-sm border rounded hover:bg-accent"
        >
          Select all
        </button>

        <button
          onClick={() => setSelectedIds(new Set())}
          className="px-3 py-1.5 text-sm border rounded hover:bg-accent"
        >
          Clear
        </button>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={assignTarget}
            onChange={(e) => setAssignTarget(e.target.value)}
            className="h-9 px-2 text-sm border rounded bg-background"
          >
            <option value="">Select user...</option>
            {users.map(u => (
              <option key={u.id} value={u.fullName}>{u.fullName}</option>
            ))}
          </select>

          <button
            onClick={handleAssign}
            disabled={selectedIds.size === 0 || !assignTarget}
            className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
          >
            Assign
          </button>

          <button
            onClick={handleUnassign}
            disabled={selectedIds.size === 0}
            className="px-4 py-1.5 text-sm font-medium border rounded hover:bg-accent disabled:opacity-50"
          >
            Unassign
          </button>
        </div>
      </div>
    )}

    {diagnosticIo && diagnosticIo.tagType && (
      <DiagnosticStepsDialog
        open={showDiagnosticDialog}
        onOpenChange={setShowDiagnosticDialog}
        tagType={diagnosticIo.tagType}
        failureMode={diagnosticIo.failureMode || undefined}
        tagName={diagnosticIo.name}
      />
    )}
  </>
  )
}