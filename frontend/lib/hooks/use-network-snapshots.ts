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
 */

import { useEffect, useRef, useState } from 'react'
import type { NetworkDeviceSnapshotMessage } from '@/lib/plc/types'

type Snapshot = NetworkDeviceSnapshotMessage['snapshot']

export interface NetworkSnapshotsState {
  /** Latest snapshot per device. Identity changes on every new message so React re-renders. */
  snapshots: Map<string, Snapshot>
  /** True while the WS is open. */
  wsConnected: boolean
}

export function useNetworkSnapshots(enabled = true): NetworkSnapshotsState {
  const [snapshots, setSnapshots] = useState<Map<string, Snapshot>>(() => new Map())
  const [wsConnected, setWsConnected] = useState(false)
  // Keep a ref of the map for synchronous reads from the WS callback so we
  // never race a stale setState. setSnapshots always creates a new Map so
  // React notices the change.
  const mapRef = useRef<Map<string, Snapshot>>(snapshots)

  useEffect(() => {
    if (!enabled) {
      setSnapshots(new Map())
      mapRef.current = new Map()
      return
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/ws`

    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const openSocket = () => {
      if (closed) return
      try {
        ws = new WebSocket(url)
      } catch {
        retryTimer = setTimeout(openSocket, 2000)
        return
      }
      ws.onopen = () => setWsConnected(true)
      ws.onclose = () => {
        setWsConnected(false)
        if (!closed) retryTimer = setTimeout(openSocket, 2000)
      }
      ws.onerror = () => { /* onclose handles retry */ }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as { type?: string; snapshot?: Snapshot }
          if (msg.type !== 'NetworkDeviceSnapshot' || !msg.snapshot) return
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
  }, [enabled])

  return { snapshots, wsConnected }
}
