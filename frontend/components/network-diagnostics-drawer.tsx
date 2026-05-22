"use client"

/**
 * Right-anchored slide-in drawer that streams UDT_NETWORK_NODE_DATA snapshots
 * for one network device. Opens its own WebSocket scoped to the drawer's
 * lifetime — closing the drawer tears down the listener so we're not paying
 * for snapshot deserialization for every node on every cycle.
 *
 * Wire format: { type: 'NetworkDeviceSnapshot', snapshot: NetworkDeviceSnapshot }
 * Broadcast by lib/plc/network/poller.ts every 5 s via plc-client-manager.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Activity, ArrowDownToLine, ArrowUpFromLine, Loader2, ServerCrash, Zap } from 'lucide-react'
import type { NetworkDeviceSnapshotMessage } from '@/lib/plc/types'

type Snapshot = NetworkDeviceSnapshotMessage['snapshot']
type Port = Snapshot['ports'][number]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** PLC tag-name prefix (matches what poller emits as snapshot.deviceName). */
  deviceName: string
}

export function NetworkDiagnosticsDrawer({ open, onOpenChange, deviceName }: Props) {
  const [current, setCurrent] = useState<Snapshot | null>(null)
  const [previous, setPrevious] = useState<Snapshot | null>(null)
  // Mirror of `current` for the WS handler so we can capture the previous
  // snapshot without calling setState from within another setState updater
  // (React 18 warns about that pattern).
  const currentRef = useRef<Snapshot | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())
  // When true, hide ports that have never linked up so the table stays focused
  // on the ports that actually carry traffic. Operator can toggle to see all 32.
  const [hideUnused, setHideUnused] = useState(true)

  // Reset between opens so an old device's data doesn't bleed into a new one.
  useEffect(() => {
    if (!open) {
      setCurrent(null)
      setPrevious(null)
      currentRef.current = null
    }
  }, [open, deviceName])

  // Tick once per second so "captured Xs ago" stays accurate without re-rendering on every WS message.
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open])

  // Drawer-scoped WS. Reconnect on close-while-still-open is intentionally
  // simple (one retry after 2s) — the parent topology page already has a
  // global WS hook that handles long-running reconnects; this is just a
  // narrow listener for the lifetime of the drawer.
  useEffect(() => {
    if (!open) return
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
      ws.onerror = () => {
        // onclose will fire right after; let it handle the retry.
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as { type?: string; snapshot?: Snapshot }
          if (msg.type !== 'NetworkDeviceSnapshot' || !msg.snapshot) return
          if (msg.snapshot.deviceName !== deviceName) return
          // Snapshot the prior frame via ref (single source of truth), then
          // schedule both setState calls independently — no setState-in-setState.
          const prior = currentRef.current
          currentRef.current = msg.snapshot
          setPrevious(prior)
          setCurrent(msg.snapshot)
        } catch {
          // Non-JSON frame or unrelated message — ignore.
        }
      }
    }

    openSocket()
    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      try {
        ws?.close()
      } catch {
        // ignore
      }
    }
  }, [open, deviceName])

  const ageSec = current ? Math.max(0, Math.floor((now - current.capturedAt) / 1000)) : null
  const linkedPortsCount = current ? current.ports.filter((p) => p.linkUp).length : 0
  const portsWithErrors = current
    ? current.ports.filter((p) => p.linkUp && (p.errorsIn > 0 || p.errorsOut > 0 || p.discardsIn > 0 || p.discardsOut > 0))
        .length
    : 0

  const visiblePorts = useMemo(() => {
    if (!current) return []
    if (!hideUnused) return current.ports
    return current.ports.filter((p) => p.linkUp || p.errorsIn > 0 || p.errorsOut > 0)
  }, [current, hideUnused])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // Right-anchored slide panel: full height, max ~50% width.
          'fixed right-0 top-0 left-auto translate-x-0 translate-y-0',
          'h-screen w-full sm:w-[640px] sm:max-w-[50vw] max-w-none rounded-none',
          'data-[state=open]:slide-in-from-right-1/2 data-[state=closed]:slide-out-to-right-1/2',
          'p-0 flex flex-col gap-0',
        )}
      >
        <DialogTitle className="sr-only">Network device diagnostics — {deviceName}</DialogTitle>
        <DialogDescription className="sr-only">
          Live per-port stats for {deviceName} refreshing every 5 seconds: link state, speed, counter deltas, errors and discards.
        </DialogDescription>

        {/* Header */}
        <div className="px-5 py-4 border-b bg-card">
          <div className="flex items-center gap-3">
            <Activity className="w-5 h-5 text-primary" />
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold truncate">{deviceName}</h2>
              <p className="text-xs text-muted-foreground">
                {current
                  ? `Product ${current.productCode} · FW ${current.firmwareMajor}.${current.firmwareMinor} · ${linkedPortsCount} port${linkedPortsCount === 1 ? '' : 's'} linked`
                  : 'Waiting for first poll cycle…'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px]',
                  wsConnected ? 'border-emerald-500/40 text-emerald-400' : 'border-amber-500/40 text-amber-400',
                )}
              >
                {wsConnected ? 'live' : 'reconnecting'}
              </Badge>
              {ageSec !== null && (
                <Badge variant="outline" className="text-[10px]">
                  {ageSec}s ago
                </Badge>
              )}
            </div>
          </div>

          {portsWithErrors > 0 && current && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              <ServerCrash className="w-3.5 h-3.5" />
              {portsWithErrors} port{portsWithErrors === 1 ? '' : 's'} reporting errors or discards
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHideUnused((v) => !v)}
              className="text-xs h-7 px-2"
            >
              {hideUnused ? 'Show all 32 ports' : 'Hide unused ports'}
            </Button>
            <p className="text-[10px] text-muted-foreground">Updates every 5 s · counters since device boot</p>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {!current && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p className="text-sm">No snapshot received yet.</p>
              <p className="text-xs text-center max-w-xs">
                The network poller broadcasts a new snapshot every 5 s. If nothing appears within ~10 s,
                check that <code className="px-1 py-0.5 rounded bg-muted text-foreground">networkPollingEnabled</code> is true and the PLC is connected.
              </p>
            </div>
          )}

          {current && visiblePorts.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-8">
              <p className="text-sm">All 32 ports are inactive.</p>
              <Button variant="outline" size="sm" onClick={() => setHideUnused(false)}>
                Show all anyway
              </Button>
            </div>
          )}

          {current && visiblePorts.length > 0 && (
            <PortTable ports={visiblePorts} prev={previous?.ports} />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-card flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground font-mono truncate">
            {current?.tagName ?? `${deviceName}_NetworkNode`}
          </p>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ────────────────────────────────────────────────────────────────────────────

function PortTable({ ports, prev }: { ports: Port[]; prev: Port[] | undefined }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b">
          <tr>
            <th className="text-left py-2 pr-3">Port</th>
            <th className="text-left py-2 pr-3">Link</th>
            <th className="text-right py-2 pr-3">
              <ArrowDownToLine className="inline w-3 h-3" /> Octets
            </th>
            <th className="text-right py-2 pr-3">
              <ArrowUpFromLine className="inline w-3 h-3" /> Octets
            </th>
            <th className="text-right py-2 pr-3">Err In</th>
            <th className="text-right py-2 pr-3">Err Out</th>
            <th className="text-right py-2 pr-3">Disc In</th>
            <th className="text-right py-2">Disc Out</th>
          </tr>
        </thead>
        <tbody>
          {ports.map((p) => {
            const prior = prev?.find((q) => q.portNumber === p.portNumber)
            return <PortRow key={p.portNumber} port={p} prior={prior} />
          })}
        </tbody>
      </table>
    </div>
  )
}

function PortRow({ port: p, prior }: { port: Port; prior: Port | undefined }) {
  const hasErrors = p.errorsIn > 0 || p.errorsOut > 0
  const hasDiscards = p.discardsIn > 0 || p.discardsOut > 0
  const isProblem = hasErrors || hasDiscards
  return (
    <tr
      className={cn(
        'border-b border-border/50 hover:bg-muted/40',
        !p.linkUp && 'opacity-50',
        isProblem && 'bg-red-500/5',
      )}
    >
      <td className="py-2 pr-3 font-mono font-semibold">{p.portNumber}</td>
      <td className="py-2 pr-3">
        <LinkBadge port={p} />
      </td>
      <td className="py-2 pr-3 text-right font-mono">
        <CounterCell value={p.octetsIn} prev={prior?.octetsIn} />
      </td>
      <td className="py-2 pr-3 text-right font-mono">
        <CounterCell value={p.octetsOut} prev={prior?.octetsOut} />
      </td>
      <td className={cn('py-2 pr-3 text-right font-mono', p.errorsIn > 0 && 'text-red-400 font-semibold')}>
        <CounterCell value={p.errorsIn} prev={prior?.errorsIn} />
      </td>
      <td className={cn('py-2 pr-3 text-right font-mono', p.errorsOut > 0 && 'text-red-400 font-semibold')}>
        <CounterCell value={p.errorsOut} prev={prior?.errorsOut} />
      </td>
      <td className={cn('py-2 pr-3 text-right font-mono', p.discardsIn > 0 && 'text-amber-400')}>
        <CounterCell value={p.discardsIn} prev={prior?.discardsIn} />
      </td>
      <td className={cn('py-2 text-right font-mono', p.discardsOut > 0 && 'text-amber-400')}>
        <CounterCell value={p.discardsOut} prev={prior?.discardsOut} />
      </td>
    </tr>
  )
}

function LinkBadge({ port }: { port: Port }) {
  if (!port.linkUp) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
        down
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-emerald-400">
      <Zap className="w-3 h-3" />
      <span className="font-mono">
        {port.speedMbps >= 1000 ? `${port.speedMbps / 1000}G` : `${port.speedMbps}M`}
      </span>
      <span className="text-muted-foreground text-[10px]">{port.fullDuplex ? 'FDX' : 'HDX'}</span>
      {port.hardwareFault && <span className="text-red-400 text-[10px]">HW</span>}
    </span>
  )
}

/**
 * Render a counter value with its delta-since-previous-snapshot. The delta tells
 * the operator whether the counter is *moving* right now, which is what diagnostics
 * actually need — a one-million-discards-since-boot value tells you nothing if
 * the device booted a year ago.
 */
function CounterCell({ value, prev }: { value: number; prev: number | undefined }) {
  const delta = prev === undefined ? null : value - prev
  return (
    <div className="flex flex-col items-end leading-tight">
      <span>{formatCounter(value)}</span>
      {delta !== null && delta !== 0 && (
        <span
          className={cn(
            'text-[9px]',
            delta > 0 ? 'text-amber-400' : 'text-muted-foreground',
          )}
        >
          {delta > 0 ? '+' : ''}
          {formatCounter(delta)}
        </span>
      )}
    </div>
  )
}

function formatCounter(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}
