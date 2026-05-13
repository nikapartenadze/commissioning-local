"use client"

import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { McmDiagramView } from '@/components/mcm-diagram-view'
import { Button } from '@/components/ui/button'
import { authFetch, API_ENDPOINTS } from '@/lib/api-config'
import { ArrowLeft, Loader2 } from 'lucide-react'

/**
 * Standalone MCM diagram viewer. Reads the current subsystem name from the
 * server's runtime config and renders <McmDiagramView mcm={...}>. Optional
 * `?tag=UL17_20_VFD` query parameter highlights a specific element. Linked
 * from the commissioning page's view picker.
 */
export default function DiagramPage() {
  const [searchParams] = useSearchParams()
  const tag = searchParams.get('tag')
  const [mcm, setMcm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const resolve = async () => {
      try {
        const res = await authFetch(API_ENDPOINTS.configurationRuntime)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { subsystemName?: string | null }
        if (!cancelled) {
          if (data?.subsystemName) {
            setMcm(data.subsystemName)
          } else {
            setError('No subsystem configured — set one in Setup first.')
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load runtime config')
        }
      }
    }
    void resolve()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 py-3 flex items-center gap-3 bg-card">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/commissioning"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link>
        </Button>
        <h1 className="text-lg font-semibold">MCM Diagram</h1>
      </header>

      <main className="flex-1 min-h-0 p-3">
        {error && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
            {error}
          </div>
        )}
        {!error && mcm == null && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Resolving subsystem…
          </div>
        )}
        {mcm && (
          <McmDiagramView mcm={mcm} highlightTag={tag} className="h-[calc(100vh-7rem)]" />
        )}
      </main>
    </div>
  )
}
