import { useState } from 'react'
import { Filter, ChevronDown, Check } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Multi-select filter popover. Mirrors the `FixedFilterPopover` in
 * fv-sheet-grid.tsx so the belt-tracking page reads as the same
 * surface as the FV grid.
 *
 * Convention:
 *  - `selected === null`           → all values pass (no filter active)
 *  - `selected === []`             → nothing passes (filter empty)
 *  - `selected === [...subset]`    → only those values pass
 */
interface Props {
  label: string
  allValues: string[]
  selected: string[] | null
  onSelect: (next: string[] | null) => void
}

export function FilterPopover({ label, allValues, selected, onSelect }: Props) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const filtered = search
    ? allValues.filter(v => v.toLowerCase().includes(search.toLowerCase()))
    : allValues
  const isFiltering = selected !== null
  const activeCount = selected?.length ?? allValues.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-9 gap-2 text-xs',
            isFiltering && 'border-primary/60 bg-primary/5 text-primary',
          )}
        >
          <Filter className="h-3.5 w-3.5" />
          <span>{label}</span>
          {isFiltering && (
            <span className="font-mono tabular-nums">
              {activeCount}/{allValues.length}
            </span>
          )}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <div className="p-2 border-b">
          <input
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-8 px-2 text-xs rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
        </div>
        <div className="flex items-center justify-between px-2 py-1.5 border-b">
          <button
            type="button"
            className="text-[10px] text-primary hover:underline"
            onClick={() => onSelect(selected === null ? [] : null)}
          >
            {selected === null ? 'Deselect All' : 'Select All'}
          </button>
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:underline"
            onClick={() => { onSelect(null); setSearch('') }}
          >
            Clear
          </button>
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {filtered.map(val => {
            const checked = selected === null || selected.includes(val)
            return (
              <label
                key={val}
                className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent rounded cursor-pointer"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(isChecked) => {
                    const current = selected === null ? [...allValues] : [...selected]
                    if (isChecked) {
                      const next = Array.from(new Set([...current, val]))
                      onSelect(next.length === allValues.length ? null : next)
                    } else {
                      onSelect(current.filter(v => v !== val))
                    }
                  }}
                />
                <span className="truncate flex-1">{val}</span>
                {checked && selected !== null && <Check className="h-3 w-3 text-primary" />}
              </label>
            )
          })}
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 py-2">No matches</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
