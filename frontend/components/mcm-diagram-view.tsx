"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, Map, RefreshCw, AlertCircle, FileImage } from 'lucide-react'
import { authFetch } from '@/lib/api-config'
import { cn } from '@/lib/utils'

interface McmDiagramResponse {
  success: boolean
  mcm: string
  svgContent: string | null
  serverUploadedAt: string | null
  fetchedAt: string | null
}

interface McmDiagramViewProps {
  /** The MCM identifier (matches Subsystem.name on cloud, e.g. "MCM09"). */
  mcm: string
  /** Tag name to highlight — matches the SVG element's id (e.g. "UL17_20_VFD"). */
  highlightTag?: string | null
  /** Optional className for outer wrapper sizing. */
  className?: string
}

/**
 * Inline SCADA layout SVG for the current MCM. Sanitizes the SVG via
 * DOMPurify before injecting so a malicious cloud payload can't execute
 * scripts on the field laptop (even though the cloud is admin-authored,
 * the field laptop is the higher-trust environment — defense in depth).
 *
 * Highlighting works by matching `highlightTag` against an element id in
 * the SVG. The SCADA exports already use tag names as element IDs
 * (e.g. <g id="UL17_20_VFD">), so for the common case no per-MCM mapping
 * file is needed.
 */
export function McmDiagramView({ mcm, highlightTag, className }: McmDiagramViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'empty'; canPull: boolean }
    | { kind: 'loaded'; svgContent: string; serverUploadedAt: string | null }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' })
  const [pulling, setPulling] = useState(false)

  const sanitized = useMemo(() => {
    if (state.kind !== 'loaded') return null
    // Allow SVG/SVG-filters profile; preserve the data-* attributes the
    // SCADA export embeds so future state-driven coloring (data-state,
    // data-tagpath) keeps working. ID attribute is kept by default.
    return DOMPurify.sanitize(state.svgContent, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_ATTR: ['data-tagpath', 'data-state', 'data-color', 'data-priority', 'inkscape:label'],
    })
  }, [state])

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const res = await authFetch(`/api/mcm-diagram/${encodeURIComponent(mcm)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as McmDiagramResponse
      if (!data.svgContent) {
        setState({ kind: 'empty', canPull: true })
        return
      }
      setState({ kind: 'loaded', svgContent: data.svgContent, serverUploadedAt: data.serverUploadedAt })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load diagram' })
    }
  }, [mcm])

  useEffect(() => {
    void load()
  }, [load])

  const handlePull = useCallback(async () => {
    setPulling(true)
    try {
      const res = await authFetch('/api/cloud/pull-mcm-diagram', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      await load()
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Pull failed' })
    } finally {
      setPulling(false)
    }
  }, [load])

  // Apply / clear highlight on the currently rendered SVG. Uses CSS class
  // on the matching element id rather than inline styles so themes can
  // restyle the highlight from one place.
  useEffect(() => {
    const root = containerRef.current
    if (!root || state.kind !== 'loaded') return
    root.querySelectorAll('.mcm-diagram-highlight').forEach(el => el.classList.remove('mcm-diagram-highlight'))
    if (!highlightTag) return
    const target = root.querySelector(`#${CSS.escape(highlightTag)}`)
    if (target) {
      target.classList.add('mcm-diagram-highlight')
      // Scroll the highlight into view if the SVG is in a scrollable parent.
      target.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'smooth' })
    }
  }, [highlightTag, state, sanitized])

  return (
    <div className={cn('rounded-lg border bg-card overflow-hidden flex flex-col', className)}>
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <Map className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold truncate">{mcm}</span>
          {highlightTag && (
            <Badge variant="outline" className="font-mono text-xs">{highlightTag}</Badge>
          )}
          {state.kind === 'loaded' && state.serverUploadedAt && (
            <span className="text-xs text-muted-foreground truncate hidden md:inline">
              · uploaded {new Date(state.serverUploadedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" className="gap-1" onClick={handlePull} disabled={pulling}>
          {pulling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Pull
        </Button>
      </div>

      <div className="flex-1 min-h-0 relative bg-white dark:bg-zinc-100">
        {state.kind === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading diagram…
          </div>
        )}
        {state.kind === 'empty' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <FileImage className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium">No diagram cached for {mcm}</p>
              <p className="text-xs text-muted-foreground mt-1">Ask an admin to upload it in the cloud app, then click Pull.</p>
            </div>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <AlertCircle className="h-8 w-8 text-amber-500" />
            <p className="text-sm">{state.message}</p>
          </div>
        )}
        {state.kind === 'loaded' && sanitized && (
          <div
            ref={containerRef}
            className="h-full w-full overflow-auto p-2 [&_svg]:max-w-full [&_svg]:h-auto [&_.mcm-diagram-highlight]:!stroke-amber-500 [&_.mcm-diagram-highlight]:!stroke-[3] [&_.mcm-diagram-highlight]:[filter:drop-shadow(0_0_6px_rgb(245_158_11_/_0.6))]"
            dangerouslySetInnerHTML={{ __html: sanitized }}
          />
        )}
      </div>
    </div>
  )
}
