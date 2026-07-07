import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskPool } from './types'

/**
 * Fetches and refreshes the Guided-Mode task pool for a subsystem.
 * The pool is recomputed server-side from live data on every call, so a
 * refresh after recording a result re-prioritises and re-gates everything.
 */
export function useTaskPool(subsystemId: number, clientId?: string) {
  const [pool, setPool] = useState<TaskPool | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reqId = useRef(0)

  const refresh = useCallback(async () => {
    if (!subsystemId || subsystemId <= 0) {
      setIsLoading(false)
      setError('No subsystem configured')
      return
    }
    const mine = ++reqId.current
    try {
      // clientId lets the server overlay OTHER testers' claims (and keep the
      // caller's own claim invisible) — see lib/guided/task-pool/claims.ts.
      const cid = clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''
      const res = await fetch(`/api/guided/tasks?subsystemId=${subsystemId}${cid}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Failed to load tasks (${res.status})`)
      }
      const data = (await res.json()) as TaskPool
      if (mine === reqId.current) {
        setPool(data)
        setError(null)
      }
    } catch (e) {
      if (mine === reqId.current) {
        setError(e instanceof Error ? e.message : 'Failed to load tasks')
      }
    } finally {
      if (mine === reqId.current) setIsLoading(false)
    }
  }, [subsystemId, clientId])

  useEffect(() => {
    setIsLoading(true)
    void refresh()
    // Multi-user: keep colleagues' progress and claims fresh. Another tester
    // completing/claiming tasks must reflect here without a manual action —
    // the pool rebuild is a handful of indexed queries, so 30 s is cheap.
    const id = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(id)
  }, [refresh])

  return { pool, isLoading, error, refresh }
}
