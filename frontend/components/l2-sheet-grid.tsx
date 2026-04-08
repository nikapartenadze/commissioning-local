"use client"

import { useState, useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { Check, X } from 'lucide-react'

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
const FIXED_COL_WIDTHS = { deviceName: 180, mcm: 80, subsystem: 90 }

function CheckCell({
  value,
  onChange,
}: {
  value: string | null
  onChange: (value: string | null) => void
}) {
  const handleClick = () => {
    if (!value) {
      onChange('pass')
    } else if (value === 'pass') {
      onChange('fail')
    } else {
      onChange(null)
    }
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

function DataCell({
  value,
  onChange,
}: {
  value: string | null
  onChange: (value: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [localValue, setLocalValue] = useState(value ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFocus = () => {
    setEditing(true)
    setLocalValue(value ?? '')
  }

  const handleBlur = () => {
    setEditing(false)
    const trimmed = localValue.trim()
    const newVal = trimmed === '' ? null : trimmed
    if (newVal !== value) {
      onChange(newVal)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      setLocalValue(value ?? '')
      inputRef.current?.blur()
    }
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
      className="w-full h-8 px-2 text-xs rounded-md border border-transparent bg-transparent hover:border-border focus:border-primary focus:bg-background focus:outline-none transition-colors"
    />
  )
}

function NotesCell({
  value,
  onChange,
}: {
  value: string | null
  onChange: (value: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [localValue, setLocalValue] = useState(value ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFocus = () => {
    setEditing(true)
    setLocalValue(value ?? '')
  }

  const handleBlur = () => {
    setEditing(false)
    const trimmed = localValue.trim()
    const newVal = trimmed === '' ? null : trimmed
    if (newVal !== value) {
      onChange(newVal)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      setLocalValue(value ?? '')
      inputRef.current?.blur()
    }
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
      placeholder="Notes..."
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

export function L2SheetGrid({
  sheet,
  columns,
  devices,
  cellValues,
  onCellChange,
}: L2SheetGridProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: devices.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  // Compute per-sheet progress
  const { completedChecks, totalChecks, percent } = useMemo(() => {
    let completed = 0
    let total = 0
    for (const d of devices) {
      completed += d.CompletedChecks
      total += d.TotalChecks
    }
    // Recount from cell values for accuracy
    const checkCols = columns.filter(c => c.ColumnType === 'check')
    let liveCompleted = 0
    let liveTotal = 0
    for (const d of devices) {
      for (const col of checkCols) {
        liveTotal++
        const cv = cellValues.get(`${d.id}-${col.id}`)
        if (cv?.Value) liveCompleted++
      }
    }
    const pct = liveTotal > 0 ? Math.round((liveCompleted / liveTotal) * 100) : 0
    return { completedChecks: liveCompleted, totalChecks: liveTotal, percent: pct }
  }, [devices, columns, cellValues])

  const getColumnWidth = useCallback((col: L2Column) => {
    switch (col.ColumnType) {
      case 'check': return 70
      case 'notes': return 180
      case 'data': return 120
      case 'readonly': return 120
      default: return 100
    }
  }, [])

  const totalFixedWidth = FIXED_COL_WIDTHS.deviceName + FIXED_COL_WIDTHS.mcm + FIXED_COL_WIDTHS.subsystem
  const totalScrollWidth = columns.reduce((sum, col) => sum + getColumnWidth(col), 0)

  const renderCell = useCallback((device: L2Device, col: L2Column) => {
    const key = `${device.id}-${col.id}`
    const cv = cellValues.get(key)
    const value = cv?.Value ?? null

    switch (col.ColumnType) {
      case 'check':
        return (
          <CheckCell
            value={value}
            onChange={(v) => onCellChange(device.id, col.id, v)}
          />
        )
      case 'data':
        return (
          <DataCell
            value={value}
            onChange={(v) => onCellChange(device.id, col.id, v)}
          />
        )
      case 'notes':
        return (
          <NotesCell
            value={value}
            onChange={(v) => onCellChange(device.id, col.id, v)}
          />
        )
      case 'readonly':
        return <ReadonlyCell value={value} />
      default:
        return (
          <DataCell
            value={value}
            onChange={(v) => onCellChange(device.id, col.id, v)}
          />
        )
    }
  }, [cellValues, onCellChange])

  return (
    <div className="flex flex-col h-full">
      {/* Grid container — full height */}
      <div className="flex-1 min-h-0 overflow-hidden bg-card">
        <div className="h-full flex flex-col">
          {/* Header */}
          <div className="flex border-b bg-muted/50 shrink-0">
            {/* Fixed header columns */}
            <div className="flex shrink-0 sticky left-0 z-20 bg-muted/50">
              <div
                className="flex items-center px-3 text-xs font-semibold text-muted-foreground border-r"
                style={{ width: FIXED_COL_WIDTHS.deviceName, height: ROW_HEIGHT }}
              >
                Device
              </div>
              <div
                className="flex items-center px-2 text-xs font-semibold text-muted-foreground border-r"
                style={{ width: FIXED_COL_WIDTHS.mcm, height: ROW_HEIGHT }}
              >
                MCM
              </div>
              <div
                className="flex items-center px-2 text-xs font-semibold text-muted-foreground border-r"
                style={{ width: FIXED_COL_WIDTHS.subsystem, height: ROW_HEIGHT }}
              >
                Subsystem
              </div>
            </div>

            {/* Scrollable header columns */}
            <div className="flex overflow-hidden">
              {columns.map(col => (
                <div
                  key={col.id}
                  className="flex items-center px-2 text-xs font-semibold text-muted-foreground border-r shrink-0"
                  style={{ width: getColumnWidth(col), height: ROW_HEIGHT }}
                  title={col.Name}
                >
                  <span className="truncate">{col.Name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Virtualized body */}
          <div
            ref={parentRef}
            className="flex-1 overflow-auto"
          >
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: totalFixedWidth + totalScrollWidth,
                position: 'relative',
              }}
            >
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
                    style={{
                      top: virtualRow.start,
                      height: ROW_HEIGHT,
                      width: totalFixedWidth + totalScrollWidth,
                    }}
                  >
                    {/* Fixed columns (sticky) */}
                    <div className="flex shrink-0 sticky left-0 z-10 bg-inherit">
                      <div
                        className="flex items-center px-3 text-xs font-medium border-r truncate"
                        style={{ width: FIXED_COL_WIDTHS.deviceName }}
                        title={device.DeviceName}
                      >
                        {device.DeviceName}
                      </div>
                      <div
                        className="flex items-center px-2 text-xs text-muted-foreground border-r"
                        style={{ width: FIXED_COL_WIDTHS.mcm }}
                      >
                        {device.Mcm}
                      </div>
                      <div
                        className="flex items-center px-2 text-xs text-muted-foreground border-r"
                        style={{ width: FIXED_COL_WIDTHS.subsystem }}
                      >
                        {device.Subsystem}
                      </div>
                    </div>

                    {/* Scrollable data columns */}
                    {columns.map(col => (
                      <div
                        key={col.id}
                        className="flex items-center px-1 border-r shrink-0"
                        style={{ width: getColumnWidth(col) }}
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
      </div>
    </div>
  )
}
