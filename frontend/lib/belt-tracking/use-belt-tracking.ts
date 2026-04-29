import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BELT_TRACKED_VALUE,
  type BeltTrackingResponse,
  type BeltTrackingError,
  type SyncPillState,
  type VfdRow,
} from './types'
import { useSignalR } from '@/lib/signalr-client'

interface CloudStatusShape {
  connected: boolean
  pendingL2SyncCount: number
  // ...other fields exist on the response but we don't need them here
}

export interface UseBeltTrackingResult {
  /** All VFDs across the project, server-defined order (Mcm → display order → name). */
  vfds: VfdRow[]
  /** True until the first successful fetch resolves. */
  loading: boolean
  /** Last fatal error from the read endpoint (or null). */
  loadError: BeltTrackingError | null
  /** Live header pill state. */
  pill: SyncPillState
  /** Mark a VFD's belt-tracked cell. value=BELT_TRACKED_VALUE to set, '' to clear. */
  markTracked: (deviceId: number, value: string) => Promise<void>
  /** Force a re-fetch of the device list (e.g. after a manual untrack). */
  refresh: () => void
}

/**
 * Mechanics page state.
 *
 * Owns the device list, the optimistic write path, and the live sync
 * pill. Polls cloud status every 5s; the polling fetch doubles as a
 * heartbeat — three consecutive failures flips the pill to
 * `server_unreachable`.
 */
export function useBeltTracking(mechanicName: string | null): UseBeltTrackingResult {
  const [columnId, setColumnId] = useState<number | null>(null)
  const [vfds, setVfds] = useState<VfdRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<BeltTrackingError | null>(null)
  const [pill, setPill] = useState<SyncPillState>({ kind: 'online' })

  /** Sequential id for the current generation of optimistic edits. Used
   *  to ignore stale fetch results that resolve after a newer write. */
  const fetchGenRef = useRef(0)
  /** Count of consecutive cloud-status fetch failures. After 3 we
   *  declare the field server itself unreachable. */
  const statusFailRef = useRef(0)

  const fetchDevices = useCallback(async () => {
    const gen = ++fetchGenRef.current
    try {
      const r = await fetch('/api/belt-tracking', { cache: 'no-store' })
      if (!r.ok) {
        const err = (await r.json().catch(() => null)) as BeltTrackingError | null
        if (gen === fetchGenRef.current) {
          setLoadError(err ?? { error: `HTTP ${r.status}`, code: 'unknown' })
          setLoading(false)
        }
        return
      }
      const data = (await r.json()) as BeltTrackingResponse
      if (gen !== fetchGenRef.current) return // stale
      setColumnId(data.beltTrackedColumnId)
      setVfds(data.vfds)
      setLoadError(null)
      setLoading(false)
    } catch (err) {
      if (gen === fetchGenRef.current) {
        setLoadError({
          error: err instanceof Error ? err.message : 'Network error',
          code: 'unknown',
        })
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => { fetchDevices() }, [fetchDevices])

  // Live updates from sibling browsers: /api/l2/cell broadcasts a
  // L2CellUpdated message via the /broadcast → /ws bridge whenever any
  // L2 cell changes (Belt Tracked, the four controls cells, anything).
  // Same channel the FV grid uses. Refetch on any match so derived
  // "Ready" state stays consistent — Ready depends on the four controls
  // columns, not just Belt Tracked.
  const signalR = useSignalR()
  const knownDeviceIds = useMemo(() => new Set(vfds.map(v => v.deviceId)), [vfds])
  useEffect(() => {
    if (!signalR?.onFVCellUpdate) return
    const handle = (update: { localDeviceId: number }) => {
      if (knownDeviceIds.has(update.localDeviceId)) {
        fetchDevices()
      }
    }
    signalR.onFVCellUpdate(handle)
    return () => { signalR.offFVCellUpdate?.(handle) }
  }, [signalR, knownDeviceIds, fetchDevices])

  // ── Cloud sync status polling ────────────────────────────────────
  useEffect(() => {
    let stopped = false
    let timer: number | null = null

    async function poll() {
      try {
        const r = await fetch('/api/cloud/status', { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const status = (await r.json()) as CloudStatusShape
        if (stopped) return
        statusFailRef.current = 0
        const pending = status.pendingL2SyncCount ?? 0
        if (status.connected && pending === 0)      setPill({ kind: 'online' })
        else if (status.connected && pending > 0)   setPill({ kind: 'syncing', pending })
        else                                        setPill({ kind: 'offline_pending', pending })
      } catch {
        if (stopped) return
        statusFailRef.current += 1
        if (statusFailRef.current >= 3) {
          setPill({ kind: 'server_unreachable' })
        }
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 5000)
      }
    }
    poll()
    return () => {
      stopped = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  // ── Optimistic write ─────────────────────────────────────────────
  const markTracked = useCallback(async (deviceId: number, value: string) => {
    if (columnId === null) return

    // Snapshot for rollback
    const previous = vfds
    const next = vfds.map(v => {
      if (v.deviceId !== deviceId) return v
      const tracked = value.trim().length > 0
      return {
        ...v,
        tracked,
        trackedBy: tracked ? (mechanicName ?? 'unknown') : null,
        trackedAt: tracked ? new Date().toISOString() : null,
        // Don't bump version here — server returns the authoritative version
        // and we'll pick it up on the next refresh. Optimistic UI doesn't
        // need to model that.
      }
    })
    setVfds(next)

    try {
      const r = await fetch('/api/l2/cell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          columnId,
          value: value || null,
          updatedBy: mechanicName ?? 'unknown',
        }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      // Successful write: enqueue a refresh so we pick up the authoritative
      // version + any concurrent writes from elsewhere. Keep the optimistic
      // state until the refresh lands so the UI never flickers.
      window.setTimeout(fetchDevices, 250)
    } catch (err) {
      console.error('[belt-tracking] markTracked failed:', err)
      // Roll back UI
      setVfds(previous)
      // Surface to the user — for now just throw; the caller toasts.
      throw err
    }
  }, [vfds, columnId, mechanicName, fetchDevices])

  return useMemo(() => ({
    vfds,
    loading,
    loadError,
    pill,
    markTracked,
    refresh: fetchDevices,
  }), [vfds, loading, loadError, pill, markTracked, fetchDevices])
}

/** Convenience: call markTracked with the canonical "Yes" value. */
export function trackedPayload(): string { return BELT_TRACKED_VALUE }
/** Convenience: clear value (untrack). */
export function untrackedPayload(): string { return '' }
