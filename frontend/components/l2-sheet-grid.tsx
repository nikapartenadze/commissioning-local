"use client"

import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { Check, X, Filter } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { normalizeL2InputType } from '@/lib/l2-utils'

interface L2Sheet {
  id: number
  Name: string
  DisplayName: string
}

interface L2Column {
  id: number
  Name: string
  ColumnType: string
  InputType?: string | null
  DisplayOrder: number
  IsSystem?: number
  IsEditable?: number
  IncludeInProgress?: number
  Description?: string | null
}

interface L2Device {
  id: number
  DeviceName: string
  Mcm: string
  Subsystem: string
  CompletedChecks: number
  TotalChecks: number
}

interface L2SheetGridProps {
  sheet: L2Sheet
  columns: L2Column[]
  devices: L2Device[]
  allDevices?: L2Device[]
  cellValues: Map<string, { Value: string | null; Version: number }>
  onCellChange: (deviceId: number, columnId: number, value: string | null) => void
  columnFilters?: Record<string, any>
  fixedFilters?: { device: string[] | null; mcm: string[] | null; subsystem: string[] | null }
  onColumnFilterChange?: (colId: number, value: any) => void
  onFixedFilterChange?: (field: "device" | "mcm" | "subsystem", value: string[] | null) => void
}

const ROW_HEIGHT = 44
const MIN_COL_WIDTH = 50

// Default fixed column widths — wider MCM to avoid word wrap
const DEFAULT_FIXED: Record<string, number> = {
  deviceName: 200,
  mcm: 140,
  subsystem: 110,
}

function baseScrollWidth(colType: string): number {
  switch (colType) {
    case 'pass_fail': return 80
    case 'text': return 180
    case 'number': return 130
    case 'readonly': return 130
    default: return 100
  }
}

// ─── Cell components ────────────────────────────────────────────────────

function CheckCell({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const handleClick = () => {
    if (!value) onChange('pass')
    else if (value === 'pass') onChange('fail')
    else onChange(null)
  }
  return (
    <button
      onClick={handleClick}
      className={cn(
        "w-full h-8 rounded-md text-xs font-medium flex items-center justify-center transition-colors",
        value === 'pass' && "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
        value === 'fail' && "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
        !value && "bg-muted text-muted-foreground hover:bg-muted/80"
      )}
    >
      {value === 'pass' && <Check className="h-3.5 w-3.5" />}
      {value === 'fail' && <X className="h-3.5 w-3.5" />}
      {!value && <span className="opacity-40">-</span>}
    </button>
  )
}

function EditableCell({ value, onChange, placeholder, inputType = 'text' }: {
  value: string | null; onChange: (v: string | null) => void; placeholder?: string; inputType?: 'text' | 'number'
}) {
  const [editing, setEditing] = useState(false)
  const [localValue, setLocalValue] = useState(value ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFocus = () => { setEditing(true); setLocalValue(value ?? '') }
  const handleBlur = () => {
    setEditing(false)
    const trimmed = localValue.trim()
    const newVal = trimmed === '' ? null : trimmed
    if (newVal !== value) onChange(newVal)
  }
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') inputRef.current?.blur()
    else if (e.key === 'Escape') { setLocalValue(value ?? ''); inputRef.current?.blur() }
  }

  return (
    <input
      ref={inputRef}
      type={inputType}
      inputMode={inputType === 'number' ? 'decimal' : undefined}
      step={inputType === 'number' ? 'any' : undefined}
      value={editing ? localValue : (value ?? '')}
      onChange={(e) => setLocalValue(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className="w-full h-8 px-2 text-xs rounded-md border border-transparent bg-transparent hover:border-border focus:border-primary focus:bg-background focus:outline-none transition-colors placeholder:text-muted-foreground/50"
    />
  )
}

function ReadonlyCell({ value }: { value: string | null }) {
  return (
    <div className="w-full h-8 px-2 text-xs rounded-md flex items-center bg-gray-50 dark:bg-gray-800 text-muted-foreground">
      {value ?? ''}
    </div>
  )
}

// ─── Resize handle ──────────────────────────────────────────────────────

function ResizeHandle({ onResizeStart }: { onResizeStart: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-[5px] cursor-col-resize z-10 group/handle flex items-center justify-center"
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onResizeStart(e) }}
    >
      <div className="w-[2px] h-3/5 rounded-full bg-border opacity-0 group-hover/handle:opacity-100 transition-opacity" />
    </div>
  )
}

// ─── Context menu constants ─────────────────────────────────────────────

const COL_TYPE_STYLES: Record<string, string> = {
  pass_fail: "bg-green-100 text-green-700 border-green-300 dark:bg-green-900 dark:text-green-300",
  number: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900 dark:text-blue-300",
  readonly: "bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400",
  text: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900 dark:text-amber-300",
}

const COL_TYPE_HINTS: Record<string, string> = {
  pass_fail: "Tap to cycle: empty \u2192 pass \u2192 fail \u2192 empty",
  number: "Type a measured or observed numeric value",
  readonly: "Pre-filled value (cannot edit)",
  text: "Free-text value",
}

// ─── Filter popovers ────────────────────────────────────────────────────

function FixedFilterPopover({
  allValues,
  selected,
  onSelect,
}: {
  allValues: string[]
  selected: string[] | null
  onSelect: (val: string[] | null) => void
}) {
  const [search, setSearch] = useState("")
  const filtered = search ? allValues.filter((v) => v.toLowerCase().includes(search.toLowerCase())) : allValues
  return (
    <div className="flex flex-col">
      <div className="p-2 border-b">
        <input
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full h-7 px-2 text-xs rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
          autoFocus
        />
      </div>
      <div className="flex items-center justify-between px-2 py-1.5 border-b">
        <button className="text-[10px] text-primary hover:underline" onClick={() => onSelect(null)}>Select All</button>
        <button className="text-[10px] text-muted-foreground hover:underline" onClick={() => onSelect([])}>Clear</button>
      </div>
      <div className="max-h-48 overflow-y-auto p-1">
        {filtered.map((val) => (
          <label key={val} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent rounded cursor-pointer">
            <Checkbox
              checked={selected === null || selected.includes(val)}
              onCheckedChange={(checked) => {
                const current = selected === null ? [...allValues] : [...selected]
                if (checked) {
                  const next = Array.from(new Set([...current, val]))
                  onSelect(next.length === allValues.length ? null : next)
                } else {
                  onSelect(current.filter((v) => v !== val))
                }
              }}
            />
            <span className="truncate">{val}</span>
          </label>
        ))}
        {filtered.length === 0 && <p className="text-xs text-muted-foreground px-2 py-1">No matches</p>}
      </div>
    </div>
  )
}

function TagFilterPopover({
  tags,
  onTagsChange,
  columnName,
}: {
  tags: string[]
  onTagsChange: (tags: string[]) => void
  columnName: string
}) {
  const [input, setInput] = useState("")
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && input.trim()) {
      e.preventDefault()
      const tag = input.trim()
      if (!tags.includes(tag)) onTagsChange([...tags, tag])
      setInput("")
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <input
        placeholder={`Filter ${columnName}... (Enter)`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full h-7 px-2 text-xs rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
        autoFocus
      />
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {tag}
              <button onClick={() => onTagsChange(tags.filter((t) => t !== tag))} className="hover:text-destructive">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <button onClick={() => onTagsChange([])} className="text-[10px] text-muted-foreground underline hover:text-foreground">Clear</button>
        </div>
      )}
    </div>
  )
}

// ─── Main grid ──────────────────────────────────────────────────────────

export function L2SheetGrid({
  sheet,
  columns,
  devices,
  allDevices,
  cellValues,
  onCellChange,
  columnFilters = {},
  fixedFilters = { device: null, mcm: null, subsystem: null },
  onColumnFilterChange,
  onFixedFilterChange,
}: L2SheetGridProps) {
  const allDevs = allDevices || devices
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStartX, setDragStartX] = useState(0)
  const [dragScrollLeft, setDragScrollLeft] = useState(0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; col: L2Column } | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // Width overrides — keyed by "fixed-{name}" or "col-{id}"
  const [widthOverrides, setWidthOverrides] = useState<Map<string, number>>(new Map())

  // Resize drag state (ref to avoid re-renders per pixel)
  const [resizing, setResizing] = useState<{ key: string; startX: number; startW: number } | null>(null)

  const virtualizer = useVirtualizer({
    count: devices.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  // Measure container width for auto-scaling
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Resize drag handlers
  useEffect(() => {
    if (!resizing) return

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - resizing.startX
      const newW = Math.max(MIN_COL_WIDTH, resizing.startW + delta)
      setWidthOverrides(prev => {
        const next = new Map(prev)
        next.set(resizing.key, newW)
        return next
      })
    }
    const onUp = () => setResizing(null)

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  // Close context menu on scroll or click outside
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('click', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  // ─── Compute effective widths ───────────────────────────────────────

  const fixedW = useMemo(() => ({
    deviceName: widthOverrides.get('fixed-deviceName') ?? DEFAULT_FIXED.deviceName,
    mcm: widthOverrides.get('fixed-mcm') ?? DEFAULT_FIXED.mcm,
    subsystem: widthOverrides.get('fixed-subsystem') ?? DEFAULT_FIXED.subsystem,
  }), [widthOverrides])

  const totalFixed = fixedW.deviceName + fixedW.mcm + fixedW.subsystem

  // Scroll column widths: user override > auto-scaled > base default
  const scrollColWidths = useMemo(() => {
    const bases = columns.map(col => baseScrollWidth(normalizeL2InputType(col.ColumnType, col.InputType)))
    const baseTotalScroll = bases.reduce((sum, w) => sum + w, 0)
    const available = containerWidth - totalFixed

    // Scale up base widths if viewport is wider (only for columns without user overrides)
    const hasAnyOverride = columns.some(col => widthOverrides.has(`col-${col.id}`))
    const scale = (!hasAnyOverride && containerWidth > 0 && available > baseTotalScroll)
      ? available / baseTotalScroll
      : 1

    return columns.map((col, i) => {
      const override = widthOverrides.get(`col-${col.id}`)
      if (override !== undefined) return override
      return Math.floor(bases[i] * scale)
    })
  }, [columns, containerWidth, totalFixed, widthOverrides])

  const totalScrollWidth = scrollColWidths.reduce((sum, w) => sum + w, 0)
  const totalContentWidth = totalFixed + totalScrollWidth

  // ─── Resize starters ───────────────────────────────────────────────

  const startFixedResize = useCallback((e: React.MouseEvent, key: string, currentW: number) => {
    setResizing({ key: `fixed-${key}`, startX: e.clientX, startW: currentW })
  }, [])

  const startColResize = useCallback((e: React.MouseEvent, colId: number, currentW: number) => {
    setResizing({ key: `col-${colId}`, startX: e.clientX, startW: currentW })
  }, [])

  // ─── Cell renderer ─────────────────────────────────────────────────

  const renderCell = useCallback((device: L2Device, col: L2Column) => {
    const key = `${device.id}-${col.id}`
    const cv = cellValues.get(key)
    const value = cv?.Value ?? null
    const inputType = normalizeL2InputType(col.ColumnType, col.InputType)

    switch (inputType) {
      case 'pass_fail':
        return <CheckCell value={value} onChange={(v) => onCellChange(device.id, col.id, v)} />
      case 'number':
        return <EditableCell value={value} onChange={(v) => onCellChange(device.id, col.id, v)} inputType="number" />
      case 'text':
        return <EditableCell value={value} onChange={(v) => onCellChange(device.id, col.id, v)} />
      case 'readonly':
        return <ReadonlyCell value={value} />
      default:
        return <EditableCell value={value} onChange={(v) => onCellChange(device.id, col.id, v)} />
    }
  }, [cellValues, onCellChange])

  const handleHeaderContextMenu = useCallback((e: React.MouseEvent, col: L2Column) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, col })
  }, [])

  // ─── Drag-to-scroll (mouse only, with dead-zone to avoid hijacking clicks/selection) ───
  const dragPendingRef = useRef(false)
  const handleDragStart = (e: React.MouseEvent) => {
    if (!scrollRef.current) return
    const target = e.target as HTMLElement
    // Skip interactive elements entirely
    if (target.closest('button') || target.closest('input') || target.closest('select') || target.closest('textarea')) return
    // Start tracking but don't activate drag yet — wait for movement threshold
    dragPendingRef.current = true
    setIsDragging(false)
    setDragStartX(e.pageX - scrollRef.current.offsetLeft)
    setDragScrollLeft(scrollRef.current.scrollLeft)
  }
  const handleDragMove = (e: React.MouseEvent) => {
    if (!scrollRef.current) return
    const x = e.pageX - scrollRef.current.offsetLeft
    const distance = Math.abs(x - dragStartX)
    // Require 8px of horizontal movement before activating drag (avoids hijacking clicks/text selection)
    if (dragPendingRef.current && !isDragging) {
      if (distance > 8) {
        setIsDragging(true)
        e.preventDefault()
      }
      return
    }
    if (!isDragging) return
    e.preventDefault()
    scrollRef.current.scrollLeft = dragScrollLeft - (x - dragStartX) * 1.5
  }
  const handleDragEnd = () => { setIsDragging(false); dragPendingRef.current = false }

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!scrollRef.current) return
    setDragStartX(e.touches[0].pageX - scrollRef.current.offsetLeft)
    setDragScrollLeft(scrollRef.current.scrollLeft)
  }
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!scrollRef.current) return
    const x = e.touches[0].pageX - scrollRef.current.offsetLeft
    scrollRef.current.scrollLeft = dragScrollLeft - (x - dragStartX) * 1.2
  }

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full w-full bg-card">
      {/* Single scroll container */}
      <div
        ref={scrollRef}
        className={cn("flex-1 overflow-auto", isDragging && "cursor-grabbing select-none")}
        onMouseDown={handleDragStart}
        onMouseMove={handleDragMove}
        onMouseUp={handleDragEnd}
        onMouseLeave={handleDragEnd}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
      >
        <div style={{ minWidth: totalContentWidth }}>

          {/* ── Sticky header ─────────────────────────────────── */}
          <div className="sticky top-0 z-30 flex border-b bg-muted" style={{ height: ROW_HEIGHT }}>
            {/* Fixed header columns — sticky left */}
            <div className="sticky left-0 z-40 flex bg-muted shrink-0 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.15)]">
              {/* Device */}
              <div className="relative flex items-center justify-between px-3 text-xs font-semibold text-muted-foreground border-r" style={{ width: fixedW.deviceName }}>
                <span>Device</span>
                <div className="flex items-center gap-0.5">
                  {onFixedFilterChange && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button className={cn("shrink-0 rounded p-0.5 z-20", fixedFilters.device !== null ? "text-primary" : "text-muted-foreground/50 hover:text-muted-foreground")}>
                          <Filter className="h-3 w-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 p-0" align="start">
                        <FixedFilterPopover
                          allValues={Array.from(new Set(allDevs.map((d) => d.DeviceName).filter(Boolean))).sort()}
                          selected={fixedFilters.device}
                          onSelect={(val) => onFixedFilterChange && onFixedFilterChange("device", val)}
                        />
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
                <ResizeHandle onResizeStart={(e) => startFixedResize(e, 'deviceName', fixedW.deviceName)} />
              </div>
              {/* MCM */}
              <div className="relative flex items-center justify-between px-2 text-xs font-semibold text-muted-foreground border-r" style={{ width: fixedW.mcm }}>
                <span>MCM</span>
                <div className="flex items-center gap-0.5">
                  {onFixedFilterChange && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button className={cn("shrink-0 rounded p-0.5 z-20", fixedFilters.mcm !== null ? "text-primary" : "text-muted-foreground/50 hover:text-muted-foreground")}>
                          <Filter className="h-3 w-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 p-0" align="start">
                        <FixedFilterPopover
                          allValues={Array.from(new Set(allDevs.map((d) => d.Mcm).filter(Boolean))).sort()}
                          selected={fixedFilters.mcm}
                          onSelect={(val) => onFixedFilterChange && onFixedFilterChange("mcm", val)}
                        />
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
                <ResizeHandle onResizeStart={(e) => startFixedResize(e, 'mcm', fixedW.mcm)} />
              </div>
              {/* Subsystem */}
              <div className="relative flex items-center justify-between px-2 text-xs font-semibold text-muted-foreground border-r" style={{ width: fixedW.subsystem }}>
                <span>Subsystem</span>
                <div className="flex items-center gap-0.5">
                  {onFixedFilterChange && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button className={cn("shrink-0 rounded p-0.5 z-20", fixedFilters.subsystem !== null ? "text-primary" : "text-muted-foreground/50 hover:text-muted-foreground")}>
                          <Filter className="h-3 w-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 p-0" align="start">
                        <FixedFilterPopover
                          allValues={Array.from(new Set(allDevs.map((d) => d.Subsystem).filter(Boolean))).sort()}
                          selected={fixedFilters.subsystem}
                          onSelect={(val) => onFixedFilterChange && onFixedFilterChange("subsystem", val)}
                        />
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
                <ResizeHandle onResizeStart={(e) => startFixedResize(e, 'subsystem', fixedW.subsystem)} />
              </div>
            </div>

            {/* Scrollable header columns */}
            {columns.map((col, colIdx) => {
              const inputType = normalizeL2InputType(col.ColumnType, col.InputType)
              const hasFilter = (() => {
                const f = columnFilters[col.id]
                if (!f) return false
                if (Array.isArray(f)) return f.length > 0
                return !f.pass || !f.fail || !f.empty
              })()
              return (
                <div
                  key={col.id}
                  className="relative flex items-center justify-between px-2 text-xs font-semibold text-muted-foreground border-r shrink-0 cursor-context-menu select-none"
                  style={{ width: scrollColWidths[colIdx] }}
                  title={`Right-click for info: ${col.Name}`}
                  onContextMenu={(e) => handleHeaderContextMenu(e, col)}
                >
                  <span className="truncate">{col.Name}</span>
                  <div className="flex items-center gap-0.5">
                    {onColumnFilterChange && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            className={cn("shrink-0 rounded p-0.5 z-20", hasFilter ? "text-primary" : "text-muted-foreground/50 hover:text-muted-foreground")}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Filter className="h-3 w-3" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-48 p-2" align="start" onClick={(e) => e.stopPropagation()}>
                          {inputType === "pass_fail" ? (
                            <div className="space-y-2">
                              <p className="text-[11px] font-medium text-muted-foreground">Show rows where:</p>
                              {(["pass", "fail", "empty"] as const).map((opt) => {
                                const current = (columnFilters[col.id] as any) || { pass: true, fail: true, empty: true }
                                return (
                                  <label key={opt} className="flex items-center gap-2 text-xs">
                                    <Checkbox
                                      checked={current[opt]}
                                      onCheckedChange={(checked) => {
                                        const prev = (columnFilters[col.id] as any) || { pass: true, fail: true, empty: true }
                                        onColumnFilterChange(col.id, { ...prev, [opt]: !!checked })
                                      }}
                                    />
                                    <span className="capitalize">{opt === "empty" ? "Empty" : opt === "pass" ? "Pass" : "Fail"}</span>
                                  </label>
                                )
                              })}
                              <button
                                onClick={() => onColumnFilterChange(col.id, undefined)}
                                className="text-[10px] text-muted-foreground underline hover:text-foreground"
                              >
                                Reset
                              </button>
                            </div>
                          ) : (
                            <TagFilterPopover
                              tags={(columnFilters[col.id] as string[]) || []}
                              onTagsChange={(tags) => onColumnFilterChange && onColumnFilterChange(col.id, tags.length > 0 ? tags : undefined)}
                              columnName={col.Name}
                            />
                          )}
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                  <ResizeHandle onResizeStart={(e) => startColResize(e, col.id, scrollColWidths[colIdx])} />
                </div>
              )
            })}
          </div>

          {/* ── Virtualized rows ──────────────────────────────── */}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(virtualRow => {
              const device = devices[virtualRow.index]
              const rowIdx = virtualRow.index
              return (
                <div
                  key={device.id}
                  className={cn(
                    "absolute left-0 flex border-b",
                    rowIdx % 2 === 0 ? "bg-card" : "bg-muted/20"
                  )}
                  style={{ top: virtualRow.start, height: ROW_HEIGHT, minWidth: totalContentWidth }}
                >
                  {/* Fixed columns — sticky left, opaque bg to hide scrolled content */}
                  <div className={cn("sticky left-0 z-10 flex shrink-0", rowIdx % 2 === 0 ? "bg-card" : "bg-muted")}>
                    <div
                      className="flex items-center px-3 text-xs font-medium border-r truncate"
                      style={{ width: fixedW.deviceName }}
                      title={device.DeviceName}
                    >
                      {device.DeviceName}
                    </div>
                    <div
                      className="flex items-center px-2 text-xs text-muted-foreground border-r"
                      style={{ width: fixedW.mcm }}
                    >
                      {device.Mcm}
                    </div>
                    <div
                      className="flex items-center px-2 text-xs text-muted-foreground border-r"
                      style={{ width: fixedW.subsystem }}
                    >
                      {device.Subsystem}
                    </div>
                  </div>

                  {/* Scrollable data columns */}
                  {columns.map((col, colIdx) => (
                    <div
                      key={col.id}
                      className="flex items-center px-1 border-r shrink-0"
                      style={{ width: scrollColWidths[colIdx] }}
                    >
                      {renderCell(device, col)}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Context menu popover */}
      {contextMenu && (
        <div
          className="fixed z-[100] bg-popover border rounded-lg shadow-lg p-3 min-w-[220px] max-w-[360px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <Badge variant="outline" className={cn("text-[10px] px-1.5", COL_TYPE_STYLES[normalizeL2InputType(contextMenu.col.ColumnType, contextMenu.col.InputType)])}>
              {normalizeL2InputType(contextMenu.col.ColumnType, contextMenu.col.InputType)}
            </Badge>
            <span className="text-sm font-semibold truncate">{contextMenu.col.Name}</span>
          </div>
          {contextMenu.col.Description ? (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {contextMenu.col.Description}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {COL_TYPE_HINTS[normalizeL2InputType(contextMenu.col.ColumnType, contextMenu.col.InputType)] || "Enter the required value"}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
