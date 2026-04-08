"use client"

import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { Check, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface L2Sheet {
  id: number
  Name: string
  DisplayName: string
}

interface L2Column {
  id: number
  Name: string
  ColumnType: string
  DisplayOrder: number
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
  cellValues: Map<string, { Value: string | null; Version: number }>
  onCellChange: (deviceId: number, columnId: number, value: string | null) => void
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
    case 'check': return 80
    case 'notes': return 200
    case 'data': return 130
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

function EditableCell({ value, onChange, placeholder }: {
  value: string | null; onChange: (v: string | null) => void; placeholder?: string
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
      type="text"
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
  check: "bg-green-100 text-green-700 border-green-300 dark:bg-green-900 dark:text-green-300",
  data: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900 dark:text-blue-300",
  readonly: "bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400",
  notes: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900 dark:text-amber-300",
}

const COL_TYPE_HINTS: Record<string, string> = {
  check: "Tap to cycle: empty \u2192 pass \u2192 fail \u2192 empty",
  data: "Type a measured or observed value",
  readonly: "Pre-filled value (cannot edit)",
  notes: "Free-text notes or comments",
}

// ─── Main grid ──────────────────────────────────────────────────────────

export function L2SheetGrid({
  sheet,
  columns,
  devices,
  cellValues,
  onCellChange,
}: L2SheetGridProps) {
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
    const bases = columns.map(col => baseScrollWidth(col.ColumnType))
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

    switch (col.ColumnType) {
      case 'check':
        return <CheckCell value={value} onChange={(v) => onCellChange(device.id, col.id, v)} />
      case 'data':
        return <EditableCell value={value} onChange={(v) => onCellChange(device.id, col.id, v)} />
      case 'notes':
        return <EditableCell value={value} onChange={(v) => onCellChange(device.id, col.id, v)} placeholder="Notes..." />
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

  // ─── Drag-to-scroll (mouse + touch) ─────────────────────────────
  const handleDragStart = (e: React.MouseEvent) => {
    if (!scrollRef.current) return
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('input') || target.closest('select') || target.closest('textarea')) return
    setIsDragging(true)
    setDragStartX(e.pageX - scrollRef.current.offsetLeft)
    setDragScrollLeft(scrollRef.current.scrollLeft)
  }
  const handleDragMove = (e: React.MouseEvent) => {
    if (!isDragging || !scrollRef.current) return
    e.preventDefault()
    const x = e.pageX - scrollRef.current.offsetLeft
    scrollRef.current.scrollLeft = dragScrollLeft - (x - dragStartX) * 1.5
  }
  const handleDragEnd = () => setIsDragging(false)

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
        className={cn("flex-1 overflow-auto", isDragging ? "cursor-grabbing select-none" : "cursor-grab")}
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
              <div className="relative flex items-center px-3 text-xs font-semibold text-muted-foreground border-r" style={{ width: fixedW.deviceName }}>
                Device
                <ResizeHandle onResizeStart={(e) => startFixedResize(e, 'deviceName', fixedW.deviceName)} />
              </div>
              {/* MCM */}
              <div className="relative flex items-center px-2 text-xs font-semibold text-muted-foreground border-r" style={{ width: fixedW.mcm }}>
                MCM
                <ResizeHandle onResizeStart={(e) => startFixedResize(e, 'mcm', fixedW.mcm)} />
              </div>
              {/* Subsystem */}
              <div className="relative flex items-center px-2 text-xs font-semibold text-muted-foreground border-r" style={{ width: fixedW.subsystem }}>
                Subsystem
                <ResizeHandle onResizeStart={(e) => startFixedResize(e, 'subsystem', fixedW.subsystem)} />
              </div>
            </div>

            {/* Scrollable header columns */}
            {columns.map((col, colIdx) => (
              <div
                key={col.id}
                className="relative flex items-center px-2 text-xs font-semibold text-muted-foreground border-r shrink-0 cursor-context-menu select-none"
                style={{ width: scrollColWidths[colIdx] }}
                title={`Right-click for info: ${col.Name}`}
                onContextMenu={(e) => handleHeaderContextMenu(e, col)}
              >
                <span className="truncate">{col.Name}</span>
                <ResizeHandle onResizeStart={(e) => startColResize(e, col.id, scrollColWidths[colIdx])} />
              </div>
            ))}
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
            <Badge variant="outline" className={cn("text-[10px] px-1.5", COL_TYPE_STYLES[contextMenu.col.ColumnType])}>
              {contextMenu.col.ColumnType}
            </Badge>
            <span className="text-sm font-semibold truncate">{contextMenu.col.Name}</span>
          </div>
          {contextMenu.col.Description ? (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {contextMenu.col.Description}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {COL_TYPE_HINTS[contextMenu.col.ColumnType] || "Enter the required value"}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
