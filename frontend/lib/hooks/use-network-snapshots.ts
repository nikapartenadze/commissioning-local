"use client"

/**
 * Hook that maintains a live cache of NetworkDeviceSnapshot keyed by
 * deviceName. Subscribes to the server's WS feed once and keeps the cache
 * fresh, so opening the Diagnostics modal renders the last-known snapshot
 * immediately instead of waiting for the next broadcast (cadence is
 * driven by the server-side poller; defaults to 60 s, configurable via
 * networkPollingIntervalMs in config.json).
 *
 * Designed for use at the Network page level — one subscription per tab.
 * Pass the returned map down to NetworkDiagnosticsView via prop; the view
 * itself no longer needs to open its own WS.
 *
 * Multi-MCM scoping: pass the route's subsystemId so the hook (a) sends a
 * Subscribe frame for server-side filtering and (b) only applies snapshots /
 * ring verdicts stamped with that subsystemId. Without this, one global
 * ringStatus was overwritten by whichever MCM broadcast last. Unstamped
 * messages are accepted ONLY when the hook has no subsystemId (legacy
 * single-MCM mode, where the singleton may broadcast without a stamp).
 */

import { useEffect, useRef, useState } from 'react'
import type { NetworkDeviceSnapshotMessage, RingStatusUpdateMessage } from '@/lib/plc/types'

type Snapshot = NetworkDeviceSnapshotMessage['snapshot']
type RingStatus = RingStatusUpdateMessage['ring']

export interface NetworkSnapshotsState {
  /** Latest snapshot per device. Identity changes on every new message so React re-renders. */
  snapshots: Map<string, Snapshot>
  /** True while the WS is open. */
  wsConnected: boolean
  /** Latest DLR ring verdict from the poller, or null until the first push. */
  ringStatus: RingStatus | null
}

export function useNetworkSnapshots(
  enabled = true,
  subsystemId?: string | number
): NetworkSnapshotsState {
  const [snapshots, setSnapshots] = useState<Map<string, Snapshot>>(() => new Map())
  const [wsConnected, setWsConnected] = useState(false)
  const [ringStatus, setRingStatus] = useState<RingStatus | null>(null)
  // Keep a ref of the map for synchronous reads from the WS callback so we
  // never race a stale setState. setSnapshots always creates a new Map so
  // React notices the change.
  const mapRef = useRef<Map<string, Snapshot>>(snapshots)

  const sid = subsystemId != null && String(subsystemId) !== '' ? String(subsystemId) : undefined

  useEffect(() => {
    if (!enabled) {
      setSnapshots(new Map())
      mapRef.current = new Map()
      return
    }

    // Fresh subscription (mount, enable, or subsystem change): drop any cached
    // data so a subsystemId switch can't render the previous MCM's devices/ring.
    setSnapshots(new Map())
    mapRef.current = new Map()
    setRingStatus(null)

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/ws`

    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let closed = false

    /**
     * Does this message belong to the MCM this hook serves? Stamped messages
     * must match; unstamped ones pass only when the hook is unscoped (legacy
     * single-MCM mode) — otherwise a sibling MCM's global broadcast would
     * overwrite our cache.
     */
    const accepts = (msgSid: unknown): boolean => {
      const stamped = msgSid != null && String(msgSid) !== '' ? String(msgSid) : undefined
      if (sid === undefined) return true
      return stamped === sid
    }

    const openSocket = () => {
      if (closed) return
      try {
        ws = new WebSocket(url)
      } catch {
        retryTimer = setTimeout(openSocket, 2000)
        return
      }
      ws.onopen = () => {
        setWsConnected(true)
        // Server-side filtering (server-express shouldDeliver): scoped hooks
        // opt into per-MCM delivery. Unstamped/global messages still arrive;
        // accepts() drops them client-side. Legacy (no sid) sends no frame.
        if (sid) {
          try {
            ws?.send(JSON.stringify({ type: 'Subscribe', subsystemIds: [sid] }))
          } catch { /* filtered client-side by accepts() regardless */ }
        }
      }
      ws.onclose = () => {
        setWsConnected(false)
        if (!closed) retryTimer = setTimeout(openSocket, 2000)
      }
      ws.onerror = () => { /* onclose handles retry */ }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type?: string
            subsystemId?: string | number
            snapshot?: Snapshot
            ring?: RingStatus
          }
          if (msg.type === 'RingStatusUpdate' && msg.ring) {
            if (accepts(msg.subsystemId)) setRingStatus(msg.ring)
            return
          }
          if (msg.type !== 'NetworkDeviceSnapshot' || !msg.snapshot) return
          if (!accepts(msg.subsystemId)) return
          const next = new Map(mapRef.current)
          next.set(msg.snapshot.deviceName, msg.snapshot)
          mapRef.current = next
          setSnapshots(next)
        } catch {
          // ignore
        }
      }
    }

    openSocket()
    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      try { ws?.close() } catch { /* ignore */ }
    }
  }, [enabled, sid])

  return { snapshots, wsConnected, ringStatus }
}
