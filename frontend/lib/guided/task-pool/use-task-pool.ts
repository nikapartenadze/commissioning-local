import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskPool } from './types'

/**
 * Fetches and refreshes the Guided-Mode task pool for a subsystem.
 * The pool is recomputed server-side from live data on every call, so a
 * refresh after recording a result re-prioritises and re-gates everything.
 */
export function useTaskPool(subsystemId: number) {
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
      const res = await fetch(`/api/guided/tasks?subsystemId=${subsystemId}`)
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
  }, [subsystemId])

  useEffect(() => {
    setIsLoading(true)
    void refresh()
  }, [refresh])

  return { pool, isLoading, error, refresh }
}
