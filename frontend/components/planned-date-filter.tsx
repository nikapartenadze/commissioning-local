import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// One control for "when is this work scheduled", shared by the I/O grid and the
// Functional Validation / VFD grids so the question looks the same everywhere.
//
// Replaces a three-part pill (bucket <select> │ bare <input type="date"> │ ×).
// That layout put a native date input permanently in the toolbar — visual noise
// that reads as an editable field the tech is meant to fill in — and separated
// the two controls by a 1px border, so a near-miss on the dropdown opened the
// calendar instead (Chrome opens the picker from anywhere in a date input).
//
// Here the exact-date input only exists once "Specific date" is chosen, so the
// common case (a bucket) cannot mis-hit it, and the trigger always states the
// current filter in words rather than showing an empty mm/dd/yyyy.

export type PlannedBucket = 'all' | 'overdue' | 'today' | 'week' | 'has' | 'none'

const BUCKETS: { key: PlannedBucket; label: string; hint?: string }[] = [
  { key: 'all', label: 'Any date' },
  { key: 'overdue', label: 'Overdue', hint: 'Planned before today' },
  { key: 'today', label: 'Due today' },
  { key: 'week', label: 'Due this week' },
  { key: 'has', label: 'Has a date' },
  { key: 'none', label: 'No date yet' },
]

/** "2026-07-24" → "07/24/26". String slicing, never Date parsing — building a
 *  Date from a date-only string and formatting it locally shifts the day. */
export function formatPlannedShort(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const [y, m, d] = value.split('-')
  return `${m}/${d}/${y.slice(2)}`
}

export function PlannedDateFilter({
  bucket,
  exactDate,
  onChange,
  className,
}: {
  bucket: PlannedBucket
  /** "" when no exact date is chosen. An exact date overrides the bucket. */
  exactDate: string
  onChange: (bucket: PlannedBucket, exactDate: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [showDateInput, setShowDateInput] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const dateInputRef = useRef<HTMLInputElement>(null)

  const active = bucket !== 'all' || !!exactDate
  const label = exactDate
    ? formatPlannedShort(exactDate)
    : (BUCKETS.find((b) => b.key === bucket)?.label ?? 'Any date')

  // Close on outside click / Escape. Both, because this is a toolbar popover a
  // tech may dismiss either way, and a stuck-open panel covers grid rows.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (showDateInput) dateInputRef.current?.focus()
  }, [showDateInput])

  function pickBucket(next: PlannedBucket) {
    // Choosing a bucket clears any exact date — they are alternatives, and
    // leaving both set was the old control's most confusing state.
    onChange(next, '')
    setShowDateInput(false)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={cn('relative shrink-0', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Filter by the date this work is planned for (set in the cloud)"
        className={cn(
          'h-[44px] px-3 flex items-center gap-2 rounded border text-sm font-medium whitespace-nowrap transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active
            ? 'border-primary text-primary'
            : 'border-border text-muted-foreground hover:text-foreground',
        )}
      >
        <CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className={cn(exactDate && 'tabular-nums')}>{label}</span>
        {active && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear planned-date filter"
            title="Clear planned-date filter"
            onClick={(e) => {
              e.stopPropagation()
              onChange('all', '')
              setShowDateInput(false)
              setOpen(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onChange('all', '')
                setShowDateInput(false)
                setOpen(false)
              }
            }}
            className="ml-0.5 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Planned date filter"
          className="absolute right-0 z-50 mt-1 w-56 rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {BUCKETS.map((b) => {
            const selected = !exactDate && bucket === b.key
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => pickBucket(b.key)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'text-primary' : 'text-foreground hover:bg-accent',
                )}
              >
                <span>
                  {b.label}
                  {b.hint && (
                    <span className="block text-[11px] text-muted-foreground">{b.hint}</span>
                  )}
                </span>
                {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
              </button>
            )
          })}

          <div className="my-1 border-t border-border" />

          {showDateInput || exactDate ? (
            <div className="p-1">
              <label
                htmlFor="planned-exact-date"
                className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Specific date
              </label>
              <input
                id="planned-exact-date"
                ref={dateInputRef}
                type="date"
                value={exactDate}
                onChange={(e) => onChange(bucket, e.target.value)}
                className="h-9 w-full rounded border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowDateInput(true)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />
              Specific date…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
