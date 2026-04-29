import { useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Cell renderers for the belt-tracking spreadsheet.
 *
 * Cells are designed to FILL the table cell edge-to-edge (no padding
 * gap around them) so the row state reads as one solid block of color.
 * Container <td> sets `p-0`; the cell renderer provides internal padding.
 *
 * Dark-mode tints use `/10` color overlays on the dark slate base
 * (rather than `/25` of dark-amber-900) — that keeps the global theme
 * coherent with the rest of the app's top-bar and avoids the muddy
 * dark-red look of saturated dark-amber backgrounds.
 */

export function CheckCell({
  value, onChange, disabled,
}: {
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
}) {
  const handleClick = () => {
    if (disabled) return
    if (!value) onChange('pass')
    else if (value === 'pass') onChange('fail')
    else onChange(null)
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={cn(
        'w-full h-full min-h-16 px-3 text-sm font-semibold flex items-center justify-center transition-colors',
        value === 'pass' && 'bg-emerald-500 text-white hover:bg-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-500',
        value === 'fail' && 'bg-red-500 text-white hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-500',
        !value && 'bg-transparent text-muted-foreground hover:bg-muted/40',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent',
      )}
    >
      {value === 'pass' && <Check className="h-4 w-4" />}
      {value === 'fail' && <X className="h-4 w-4" />}
      {!value && <span className="opacity-50 text-lg">—</span>}
    </button>
  )
}

export function EditableCell({
  value, onChange, placeholder, inputType = 'text', disabled,
}: {
  value: string | null
  onChange: (v: string | null) => void
  placeholder?: string
  inputType?: 'text' | 'number'
  disabled?: boolean
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
      disabled={disabled}
      value={editing ? localValue : (value ?? '')}
      onChange={(e) => setLocalValue(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={cn(
        'w-full h-full min-h-16 px-3 text-sm bg-transparent transition-colors',
        'hover:bg-muted/40 focus:bg-background focus:outline focus:outline-2 focus:outline-primary focus:-outline-offset-2',
        'placeholder:text-muted-foreground/50',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent',
      )}
    />
  )
}

export function ReadonlyCell({ value }: { value: string | null }) {
  return (
    <div className="w-full h-full min-h-16 px-3 text-sm flex items-center text-muted-foreground/60">
      {value ?? <span className="opacity-50 text-lg">—</span>}
    </div>
  )
}

/**
 * "Ready for Tracking" pseudo-cell. Status only — no attribution.
 * Mechanics don't need to know which tech verified controls; they
 * just need to know which row is actionable.
 */
export function ReadyCell({ ready }: { ready: boolean }) {
  if (!ready) {
    return (
      <div className="w-full h-full min-h-16 px-3 flex items-center text-muted-foreground/30">
        <span className="opacity-60 text-lg">—</span>
      </div>
    )
  }
  return (
    <div className="w-full h-full min-h-16 px-3 flex items-center gap-3 text-sm font-semibold uppercase tracking-wider bg-emerald-500/15 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100">
      <div className="w-7 h-7 rounded-full bg-emerald-500 dark:bg-emerald-400 flex items-center justify-center shrink-0">
        <Check className="h-4 w-4 text-white dark:text-emerald-950" strokeWidth={3} />
      </div>
      <span>Ready</span>
    </div>
  )
}

/**
 * Belt Tracked cell. Three states. The control is a real button INSIDE
 * the cell (with padding around it) so it reads as something you press,
 * not as a colored row band.
 *
 *  - Tracked:               emerald solid button
 *  - Ready, not tracked:    amber outlined CTA button
 *  - Not ready (disabled):  blank cell with "—"
 */
export function TrackedToggleCell({
  tracked, disabled, onChange,
}: {
  tracked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  if (disabled) {
    return (
      <div className="w-full h-full min-h-16 flex items-center justify-center text-muted-foreground/30">
        <span className="opacity-60 text-lg">—</span>
      </div>
    )
  }
  if (tracked) {
    return (
      <div className="px-3 py-1.5 h-full min-h-16 flex items-center">
        <button
          type="button"
          onClick={() => onChange(false)}
          className={cn(
            'w-full h-11 rounded-md text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1.5',
            'bg-emerald-500 text-white border border-emerald-600 shadow-sm',
            'hover:bg-emerald-600 active:bg-emerald-700 active:scale-[0.98] transition-all',
            'dark:bg-emerald-600 dark:border-emerald-700 dark:hover:bg-emerald-500',
          )}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
          <span>Tracked</span>
        </button>
      </div>
    )
  }
  return (
    <div className="px-3 py-1.5 h-full min-h-16 flex items-center">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={cn(
          'w-full h-11 rounded-md text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-1.5',
          'bg-background text-amber-700 border border-amber-500 shadow-sm',
          'hover:bg-amber-50 hover:border-amber-600 active:scale-[0.98] transition-all',
          'dark:text-amber-300 dark:border-amber-500 dark:hover:bg-amber-500/10',
        )}
      >
        <span className="opacity-60 text-base leading-none">—</span>
        <span>Mark Tracked</span>
      </button>
    </div>
  )
}

function friendlyDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  const wasYesterday = d.toDateString() === yesterday.toDateString()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `today ${hh}:${mm}`
  if (wasYesterday) return `yesterday ${hh}:${mm}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
