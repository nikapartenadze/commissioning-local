// Sort-direction indicator + clickable column header for the IO grid.
// Extracted verbatim from enhanced-io-data-grid.tsx. Both are pure
// presentational components — everything (including the onSort callback) comes
// via props; they hold no dependency on the grid's state or refs.

import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SortColumn, SortDir } from "./types"

// Sort direction indicator shown in clickable column headers.
export function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-30" />
  return dir === 'asc'
    ? <ChevronUp className="h-3 w-3 shrink-0" />
    : <ChevronDown className="h-3 w-3 shrink-0" />
}

// Clickable column header. The wrapper div keeps the column's width / sticky /
// background styling; the inner <button> owns padding + click. Rendering the
// hit target as a <button> also lets the grid's drag-to-scroll guard
// (target.closest('button')) skip it, so clicking a header sorts instead of
// starting a drag.
export function SortHeader({
  column, label, active, dir, onSort, align = 'left', className, style, title,
}: {
  column: SortColumn
  label: string
  active: boolean
  dir: SortDir
  onSort: (c: SortColumn) => void
  align?: 'left' | 'center'
  className?: string
  style?: React.CSSProperties
  title?: string
}) {
  return (
    <div className={cn("flex-shrink-0", className)} style={style} title={title}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "w-full h-full px-4 py-3 text-sm font-bold uppercase tracking-wide flex items-center gap-1 select-none transition-colors hover:text-[#C6941A]",
          align === 'center' ? "justify-center" : "justify-start",
          active ? "text-[#C6941A]" : "text-foreground"
        )}
        title={active ? `Sorted ${dir === 'asc' ? 'ascending' : 'descending'} — click to reverse` : `Sort by ${label}`}
      >
        <span className="truncate">{label}</span>
        <SortArrow active={active} dir={dir} />
      </button>
    </div>
  )
}
