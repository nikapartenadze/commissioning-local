"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Network, ChevronDown, ChevronRight, ZoomIn, ZoomOut, Maximize2, X } from 'lucide-react'
import { authFetch, API_ENDPOINTS } from '@/lib/api-config'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────

interface NetworkPort {
  id: number
  nodeId: number
  portNumber: number
  cableLabel: string | null
  deviceName: string | null
  deviceIp: string | null
  deviceType: string | null
  statusTag: string | null
}

interface NetworkNode {
  id: number
  ringId: number
  name: string
  position: number
  ipAddress: string | null
  cableIn: string | null
  cableOut: string | null
  statusTag: string | null
  totalPorts: number
  ports: NetworkPort[]
}

interface NetworkRing {
  id: number
  subsystemId: number
  name: string
  mcmName: string
  mcmIp: string | null
  mcmTag: string | null
  nodes: NetworkNode[]
}

interface TopologyResponse {
  success: boolean
  rings: NetworkRing[]
  error?: string
}

// ── Status helpers ─────────────────────────────────────────────────

type StatusColor = 'green' | 'red' | 'gray' | 'yellow'

// tagStates: map of tagName → faulted (true = faulted/red, false = healthy/green, null = unreachable)
function getStatusColor(statusTag: string | null, tagStates: Record<string, boolean | null>): StatusColor {
  if (!statusTag) return 'gray'     // No tag configured — not monitored
  const value = tagStates[statusTag]
  if (value === undefined) return 'gray'   // Tag not yet polled (first load)
  if (value === null) return 'yellow'      // Tag configured but can't reach — unreachable
  return value ? 'red' : 'green'           // ConnectionFaulted: true = faulted, false = healthy
}

function statusToHex(s: StatusColor): string {
  if (s === 'green') return '#22c55e'
  if (s === 'red') return '#ef4444'
  if (s === 'yellow') return '#eab308'
  return 'hsl(var(--muted))'
}

function StatusDot({ status, size = 'sm' }: { status: StatusColor; size?: 'sm' | 'md' }) {
  const colors = {
    green: 'bg-emerald-400 shadow-emerald-400/50',
    red: 'bg-red-500 shadow-red-500/50',
    yellow: 'bg-yellow-500 shadow-yellow-500/30',
    gray: 'bg-gray-500 shadow-gray-500/30',
  }
  const sizeClass = size === 'md' ? 'w-3 h-3' : 'w-2.5 h-2.5'
  return (
    <span className={cn('inline-block rounded-full shadow-sm', sizeClass, colors[status])} />
  )
}

// ── Device type badge colors ───────────────────────────────────────

const DEVICE_TYPE_COLORS: Record<string, string> = {
  VFD: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  FIOM: 'bg-teal-500/10 text-teal-400 border-teal-500/30',
  PMM: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  POINT_IO: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  SIO: 'bg-green-500/10 text-green-400 border-green-500/30',
}

function getDeviceType(name: string): string {
  if (name.includes('VFD')) return 'VFD'
  if (name.includes('FIOM')) return 'FIOM'
  if (name.includes('PMM')) return 'PMM'
  if (name.includes('SIO')) return 'SIO'
  if (name.includes('POINT')) return 'POINT_IO'
  return 'Unknown'
}

// ── Ring Layout (CSS flex, no SVG) ─────────────────────────────────

function RingLayout({
  ring,
  expandedNodeId,
  onToggleNode,
  tagStates,
}: {
  ring: NetworkRing
  expandedNodeId: number | null
  onToggleNode: (id: number) => void
  tagStates: Record<string, boolean | null>
}) {
  const nodes = ring.nodes
  const containerRef = useRef<HTMLDivElement>(null)
  const mcmRef = useRef<HTMLDivElement>(null)
  const lastNodeRef = useRef<HTMLButtonElement>(null)
  const [returnPath, setReturnPath] = useState<{ left: number; right: number } | null>(null)

  useEffect(() => {
    const measure = () => {
      if (!containerRef.current || !mcmRef.current || !lastNodeRef.current) return
      const containerRect = containerRef.current.getBoundingClientRect()
      const mcmRect = mcmRef.current.getBoundingClientRect()
      const lastRect = lastNodeRef.current.getBoundingClientRect()
      setReturnPath({
        left: mcmRect.left + mcmRect.width / 2 - containerRect.left,
        right: containerRect.right - (lastRect.left + lastRect.width / 2),
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [nodes.length])

  return (
    <div className="relative" ref={containerRef}>
      {/* Ring: top row of nodes with connecting lines */}
      <div className="relative px-4 pt-4 pb-4">
        {/* Forward path: horizontal flex row */}
        <div className="flex items-center gap-0">
          {/* MCM Controller */}
          <div className="shrink-0" ref={mcmRef}>
            <div className="relative rounded-lg border-2 border-blue-500/50 bg-blue-500/10 px-5 py-4 min-w-[170px] text-center">
              <div className="absolute top-2 right-2">
                <StatusDot status={getStatusColor(ring.mcmTag, tagStates)} size="md" />
              </div>
              <p className="text-sm font-bold text-blue-500">{ring.mcmName}</p>
              <p className="text-xs font-mono text-blue-400/70 mt-0.5">{ring.mcmIp || ''}</p>
              <Badge variant="outline" className="mt-1.5 text-[10px] border-blue-500/30 text-blue-400">
                Controller
              </Badge>
            </div>
          </div>

          {/* Connecting lines + DPM nodes */}
          {nodes.map((node, idx) => {
            const isExpanded = expandedNodeId === node.id
            const status = getStatusColor(node.statusTag, tagStates)
            const deviceCount = node.ports.filter((p) => p.deviceName).length
            const isLast = idx === nodes.length - 1

            return (
              <div key={node.id} className="flex items-center">
                {/* Dashed connecting line */}
                <div className="w-12 sm:w-16 md:w-24 border-t-2 border-dashed border-emerald-500/50" />

                {/* DPM Node */}
                <button
                  ref={isLast ? lastNodeRef : undefined}
                  onClick={() => onToggleNode(node.id)}
                  className={cn(
                    'shrink-0 relative rounded-lg border-2 px-5 py-4 min-w-[170px] text-center transition-all',
                    isExpanded
                      ? 'border-blue-400 bg-accent ring-1 ring-blue-400/20'
                      : 'border-border bg-card hover:border-muted-foreground'
                  )}
                >
                  <div className="absolute top-2 right-2">
                    <StatusDot status={status} size="md" />
                  </div>
                  <p className="text-sm font-bold text-foreground">{node.name}</p>
                  <p className="text-xs font-mono text-muted-foreground mt-0.5">{node.ipAddress || ''}</p>
                  <Badge
                    variant="outline"
                    className="mt-1.5 text-[10px] border-border text-muted-foreground"
                  >
                    {deviceCount} devices
                  </Badge>
                  <div className="absolute -bottom-1 left-1/2 -translate-x-1/2">
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-blue-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground rotate-90" />
                    )}
                  </div>
                </button>
              </div>
            )
          })}
        </div>

      </div>
      {/* Return path: bottom loop connecting MCM back to last DPM */}
      {returnPath && (
        <div className="relative h-6">
          {/* Left vertical drop from MCM center */}
          <div
            className="absolute top-0 w-0 h-3 border-l-2 border-dashed border-emerald-500/40"
            style={{ left: `${returnPath.left}px` }}
          />
          {/* Right vertical drop from last DPM center */}
          <div
            className="absolute top-0 w-0 h-3 border-l-2 border-dashed border-emerald-500/40"
            style={{ right: `${returnPath.right}px` }}
          />
          {/* Horizontal bar across bottom */}
          <div
            className="absolute top-3 border-t-2 border-dashed border-emerald-500/40"
            style={{ left: `${returnPath.left}px`, right: `${returnPath.right}px` }}
          />
        </div>
      )}
    </div>
  )
}

// ── Pannable/Zoomable viewport ────────────────────────────────────

function useViewport(containerRef: React.RefObject<HTMLDivElement | null>) {
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const [, forceRender] = useState(0)
  const dragging = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })

  const update = useCallback(() => forceRender((n) => n + 1), [])

  // Attach wheel listener as non-passive so preventDefault actually stops page scroll
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = el.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const oldZoom = zoomRef.current
      const delta = e.deltaY > 0 ? -0.1 : 0.1
      const newZoom = Math.min(3, Math.max(0.2, oldZoom + delta))
      panRef.current = {
        x: mouseX - (mouseX - panRef.current.x) * (newZoom / oldZoom),
        y: mouseY - (mouseY - panRef.current.y) * (newZoom / oldZoom),
      }
      zoomRef.current = newZoom
      update()
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [containerRef, update])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    panRef.current = {
      x: panRef.current.x + e.clientX - lastMouse.current.x,
      y: panRef.current.y + e.clientY - lastMouse.current.y,
    }
    lastMouse.current = { x: e.clientX, y: e.clientY }
    update()
  }, [update])

  const onMouseUp = useCallback(() => { dragging.current = false }, [])

  const zoomIn = useCallback(() => { zoomRef.current = Math.min(3, zoomRef.current + 0.2); update() }, [update])
  const zoomOut = useCallback(() => { zoomRef.current = Math.max(0.2, zoomRef.current - 0.2); update() }, [update])
  const resetView = useCallback(() => { zoomRef.current = 1; panRef.current = { x: 0, y: 0 }; update() }, [update])

  return { zoom: zoomRef.current, pan: panRef.current, onMouseDown, onMouseMove, onMouseUp, zoomIn, zoomOut, resetView }
}

// ── Star Diagram: thin vertical device cards, distance-sorted lanes ─

const PORT_FILL: Record<string, string> = {
  VFD: '#e74c3c',      // red
  FIOM: '#2980b9',     // steel blue
  PMM: '#e67e22',      // orange
  SIO: '#8e44ad',      // deep purple
  POINT_IO: '#27ae60', // emerald
}

function StarDiagram({ node, tagStates }: { node: NetworkNode; tagStates: Record<string, boolean | null> }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const vp = useViewport(viewportRef)
  const [selectedDevice, setSelectedDevice] = useState<{ name: string; type: string; ip: string; port: number; x: number; y: number } | null>(null)

  const connectedPorts = node.ports.filter((p) => p.deviceName)
  const totalPorts = node.totalPorts

  // ── Thin vertical device cards, positioned above their port column ──
  const DEVICE_W = 32
  const DEVICE_H = 120

  // Port strip — spaced wide so devices sit directly above their port
  const PORT_RECT_W = 28
  const PORT_RECT_H = 24
  const PORT_SPACING = 48 // generous spacing between port slots
  const portStripW = (totalPorts - 1) * PORT_SPACING + PORT_RECT_W

  // DPM block (wide, short) — always 4 rows, columns sized to fit
  const DPM_PORT_R = 18
  const DPM_PORT_ROWS = 4
  const DPM_PORT_COLS = Math.ceil(totalPorts / DPM_PORT_ROWS)
  const DPM_PORT_SPACE_X = 52
  const DPM_PORT_SPACE_Y = 52
  const DPM_PAD_X = 32
  const DPM_PAD_TOP = 24
  const DPM_PAD_BOT = 24
  const dpmW = DPM_PAD_X * 2 + (DPM_PORT_COLS - 1) * DPM_PORT_SPACE_X + DPM_PORT_R * 2
  const dpmH = DPM_PAD_TOP + (DPM_PORT_ROWS - 1) * DPM_PORT_SPACE_Y + DPM_PORT_R * 2 + DPM_PAD_BOT

  const totalW = Math.max(portStripW, dpmW) + 100

  // Port strip is the widest element — center everything off it
  const portStripStartX = totalW / 2 - portStripW / 2 + PORT_RECT_W / 2
  const dpmX = totalW / 2 - dpmW / 2

  // Each port gets an X position; devices sit directly above their port
  function portStripCx(portNum: number) { return portStripStartX + (portNum - 1) * PORT_SPACING }
  // Device X = its port's X (no separate device row — they're above their ports)
  function devCx(devIdx: number) { return portStripCx(connectedPorts[devIdx].portNumber) }

  // ── Layout Y positions ──
  const DEVICE_Y = 10
  const PORT_STRIP_Y = DEVICE_Y + DEVICE_H + 20
  const DPM_LABEL_H = 36 // space for name above the card
  const DPM_Y = PORT_STRIP_Y + PORT_RECT_H + 20 + DPM_LABEL_H
  const totalH = DPM_Y + dpmH + 20

  // DPM port position — numbered column-by-column (top→bottom, then next column)
  // portNum 1-based → grid position
  function dpmPortPos(portNum: number) {
    const idx = portNum - 1
    const col = Math.floor(idx / DPM_PORT_ROWS)
    const row = idx % DPM_PORT_ROWS
    return {
      x: dpmX + DPM_PAD_X + DPM_PORT_R + col * DPM_PORT_SPACE_X,
      y: DPM_Y + DPM_PAD_TOP + DPM_PORT_R + row * DPM_PORT_SPACE_Y,
    }
  }

  const allPorts = Array.from({ length: totalPorts }, (_, i) =>
    node.ports.find((p) => p.portNumber === i + 1) || null
  )

  return (
    <div className="mt-3 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-3 px-1">
        <span className="text-sm font-semibold text-foreground">{node.name}</span>
        <span className="text-xs text-muted-foreground">
          {connectedPorts.length} connected / {totalPorts} total ports
        </span>
        {node.ipAddress && (
          <span className="ml-auto text-xs font-mono text-muted-foreground">{node.ipAddress}</span>
        )}
      </div>

      {/* Legend + zoom controls */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3 flex-wrap">
          {Object.entries(PORT_FILL).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: color }} />
              <span className="text-[10px] text-muted-foreground">{type}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={vp.zoomOut} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-[10px] text-muted-foreground w-10 text-center">{Math.round(vp.zoom * 100)}%</span>
          <button onClick={vp.zoomIn} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <ZoomIn className="w-4 h-4" />
          </button>
          <button onClick={vp.resetView} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Viewport */}
      <div
        ref={viewportRef}
        className="relative overflow-hidden rounded-lg border bg-card/50 cursor-grab active:cursor-grabbing select-none"
        style={{ height: 700 }}
        onMouseDown={(e) => { vp.onMouseDown(e); setSelectedDevice(null) }}
        onMouseMove={vp.onMouseMove}
        onMouseUp={vp.onMouseUp}
        onMouseLeave={vp.onMouseUp}
      >
        <svg
          width={totalW}
          height={totalH}
          viewBox={`0 0 ${totalW} ${totalH}`}
          style={{
            transform: `translate(${vp.pan.x}px, ${vp.pan.y}px) scale(${vp.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {/* ── Cable lines: green/red based on device status ── */}
          {connectedPorts.map((port) => {
            const psx = portStripCx(port.portNumber)
            const s = getStatusColor(port.statusTag, tagStates)
            const lineColor = statusToHex(s)

            return (
              <line key={`cable-${port.id}`}
                x1={psx} y1={DEVICE_Y + DEVICE_H}
                x2={psx} y2={PORT_STRIP_Y}
                stroke={lineColor} strokeWidth={1.5} strokeOpacity={0.7}
              />
            )
          })}

          {/* ── Device cards: blue header, green/red body based on status ── */}
          {connectedPorts.map((port, devIdx) => {
            const cx = devCx(devIdx)
            const deviceType = getDeviceType(port.deviceName || '')
            const headerColor = '#3b82f6' // blue header strip
            const s = getStatusColor(port.statusTag, tagStates)
            const bodyColor = statusToHex(s)

            return (
              <g key={`dev-${port.id}`} className="cursor-pointer" onClick={(e) => {
                e.stopPropagation()
                const rect = viewportRef.current?.getBoundingClientRect()
                if (rect) setSelectedDevice({
                  name: port.deviceName || '',
                  type: deviceType,
                  ip: port.deviceIp || 'No IP',
                  port: port.portNumber,
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                })
              }}>
                {/* Card body — green/red based on status */}
                <rect
                  x={cx - DEVICE_W / 2} y={DEVICE_Y}
                  width={DEVICE_W} height={DEVICE_H}
                  rx={4}
                  fill={bodyColor} fillOpacity={0.1}
                  stroke={bodyColor} strokeWidth={1.5} strokeOpacity={0.7}
                />
                {/* Blue header strip (device type) */}
                <rect x={cx - DEVICE_W / 2} y={DEVICE_Y} width={DEVICE_W} height={16} rx={4} fill={headerColor} fillOpacity={0.3} />
                <rect x={cx - DEVICE_W / 2} y={DEVICE_Y + 12} width={DEVICE_W} height={4} fill={headerColor} fillOpacity={0.3} />
                <text x={cx} y={DEVICE_Y + 11} textAnchor="middle" fontSize={7} fontWeight="bold" fill={headerColor}>
                  {deviceType}
                </text>
                {/* Device name */}
                <text
                  x={cx} y={DEVICE_Y + 24}
                  textAnchor="start"
                  fontSize={8} fontWeight="bold" className="fill-foreground"
                  transform={`rotate(90, ${cx}, ${DEVICE_Y + 24})`}
                >
                  {port.deviceName}
                </text>
                <rect x={cx - 2} y={DEVICE_Y + DEVICE_H - 1} width={4} height={3} rx={1} fill={bodyColor} fillOpacity={0.6} />
              </g>
            )
          })}

          {/* ── Port reference strip: green/red based on status ── */}
          {allPorts.map((port, i) => {
            const portNum = i + 1
            const cx = portStripCx(portNum)
            const isConnected = !!port?.deviceName
            const s = isConnected ? getStatusColor(port!.statusTag, tagStates) : 'gray'
            const statusColor = statusToHex(s)

            return (
              <g key={`strip-${i}`}>
                <rect
                  x={cx - PORT_RECT_W / 2} y={PORT_STRIP_Y}
                  width={PORT_RECT_W} height={PORT_RECT_H}
                  rx={3}
                  fill={isConnected ? statusColor : 'hsl(var(--card))'}
                  fillOpacity={isConnected ? 0.15 : 0.5}
                  stroke={isConnected ? statusColor : 'hsl(var(--border))'}
                  strokeWidth={isConnected ? 1.5 : 1}
                  strokeOpacity={isConnected ? 0.8 : 0.4}
                />
                <text
                  x={cx} y={PORT_STRIP_Y + PORT_RECT_H / 2 + 4}
                  textAnchor="middle" fontSize={9} fontWeight="bold" fontFamily="monospace"
                  fill={isConnected ? (s === 'gray' ? 'hsl(var(--foreground))' : statusColor) : 'hsl(var(--muted-foreground))'}
                >
                  {portNum}
                </text>
              </g>
            )
          })}
          <text
            x={portStripCx(1) - PORT_RECT_W / 2 - 8}
            y={PORT_STRIP_Y + PORT_RECT_H / 2 + 4}
            textAnchor="end" fontSize={9} className="fill-muted-foreground" fontFamily="monospace"
          >
            PORTS
          </text>

          {/* ── DPM label (outside, above card) ── */}
          {(() => {
            const dpmStatus = getStatusColor(node.statusTag, tagStates)
            const dpmStroke = statusToHex(dpmStatus)
            const dpmLabelColor = dpmStatus === 'gray' ? 'hsl(var(--primary))' : statusToHex(dpmStatus)
            return (
              <>
                <text x={dpmX + dpmW / 2} y={DPM_Y - DPM_LABEL_H + 14} textAnchor="middle" fontSize={14} fontWeight="bold" fill={dpmLabelColor}>
                  {node.name}
                </text>
                <text x={dpmX + dpmW / 2} y={DPM_Y - DPM_LABEL_H + 30} textAnchor="middle" fontSize={10} fontFamily="monospace" className="fill-muted-foreground">
                  DATA POWER MODULE
                </text>
                <rect x={dpmX} y={DPM_Y} width={dpmW} height={dpmH} rx={8} fill="hsl(var(--card))" stroke={dpmStroke} strokeWidth={2} />
              </>
            )
          })()}

          {/* Port circles inside DPM — green/red based on status */}
          {allPorts.map((_, i) => {
            const portNum = i + 1
            const { x, y } = dpmPortPos(portNum)
            const port = allPorts[i]
            const isConnected = !!port?.deviceName
            const s = isConnected ? getStatusColor(port!.statusTag, tagStates) : 'gray'
            const portColor = statusToHex(s)

            return (
              <g key={`dpm-port-${i}`}>
                <circle cx={x} cy={y} r={DPM_PORT_R}
                  fill={portColor} fillOpacity={isConnected ? 0.85 : 0.4}
                  stroke={isConnected ? 'hsl(var(--foreground))' : 'hsl(var(--border))'} strokeWidth={isConnected ? 2 : 1}
                />
                {isConnected && (
                  <circle cx={x} cy={y} r={DPM_PORT_R - 6} fill="none" stroke="hsl(var(--card))" strokeWidth={2} />
                )}
                <text x={x} y={y + 4.5} textAnchor="middle" fontSize={12} fontWeight="bold" fontFamily="monospace"
                  fill={isConnected ? 'hsl(var(--card))' : 'hsl(var(--muted-foreground))'}
                >
                  {portNum}
                </text>
              </g>
            )
          })}
        </svg>

        {/* Click popup for device info */}
        {selectedDevice && (
          <div
            className="absolute z-10 bg-popover border rounded-lg shadow-lg p-3 min-w-[200px]"
            style={{ left: Math.min(selectedDevice.x, 300), top: Math.max(selectedDevice.y - 80, 8) }}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-bold text-sm text-foreground">{selectedDevice.name}</span>
              <button onClick={() => setSelectedDevice(null)} className="text-muted-foreground hover:text-foreground p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>Type: <span className="font-medium" style={{ color: PORT_FILL[selectedDevice.type] }}>{selectedDevice.type}</span></p>
              <p>IP: <span className="font-mono text-foreground">{selectedDevice.ip}</span></p>
              <p>Port: <span className="font-mono text-foreground">{selectedDevice.port}</span></p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────

interface NetworkTopologyViewProps {
  subsystemId?: number
}

export default function NetworkTopologyView({ subsystemId }: NetworkTopologyViewProps) {
  const [rings, setRings] = useState<NetworkRing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedNodeId, setExpandedNodeId] = useState<number | null>(null)
  const [tagStates, setTagStates] = useState<Record<string, boolean | null>>({})

  // Poll PLC for network device status tags every 3 seconds
  useEffect(() => {
    if (rings.length === 0) return
    let cancelled = false

    async function pollStatus() {
      try {
        const params = subsystemId ? `?subsystemId=${subsystemId}` : ''
        const res = await authFetch(`/api/network/status${params}`)
        const data = await res.json()
        if (!cancelled && data.success && data.tags) {
          setTagStates(data.tags)
        }
      } catch {
        // Ignore polling errors
      }
    }

    pollStatus()
    const interval = setInterval(pollStatus, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [rings, subsystemId])

  useEffect(() => {
    async function fetchTopology() {
      setLoading(true)
      setError(null)
      try {
        // 1. Try local data first
        const params = subsystemId ? `?subsystemId=${subsystemId}` : ''
        const res = await authFetch(`${API_ENDPOINTS.networkTopology}${params}`)
        const data: TopologyResponse = await res.json()

        if (data.success && data.rings.length > 0) {
          setRings(data.rings)
          return
        }

        // 2. No local data — try pulling from cloud (uses saved config)
        try {
          const pullRes = await authFetch('/api/cloud/pull-network', { method: 'POST' })
          const pullData = await pullRes.json()

          if (pullData.success && pullData.rings > 0) {
            // Re-fetch local data after cloud pull
            const res2 = await authFetch(`${API_ENDPOINTS.networkTopology}${params}`)
            const data2: TopologyResponse = await res2.json()
            if (data2.success) {
              setRings(data2.rings)
              return
            }
          }
        } catch {
          // Cloud pull failed — not an error, just no data
        }

        // 3. No data anywhere
        setRings([])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error')
      } finally {
        setLoading(false)
      }
    }
    fetchTopology()
  }, [subsystemId])

  function handleToggleNode(nodeId: number) {
    setExpandedNodeId((prev) => (prev === nodeId ? null : nodeId))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mr-2" />
        <span className="text-muted-foreground">Loading network topology...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-red-400">Error: {error}</p>
      </div>
    )
  }

  if (rings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Network className="w-10 h-10 mb-2" />
        <p>No network topology data found.</p>
        <p className="text-sm mt-1">Run the network seed script to populate data.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {rings.map((ring) => {
        const expandedNode = ring.nodes.find((n) => n.id === expandedNodeId) || null

        return (
          <Card key={ring.id} className="bg-card border">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-lg text-foreground">
                <Network className="w-5 h-5 text-blue-400" />
                {ring.name}
                <Badge variant="outline" className="ml-2 text-xs text-muted-foreground border-border">
                  {ring.nodes.length} DPMs
                </Badge>
                <Badge variant="outline" className="text-xs text-muted-foreground border-border">
                  {ring.nodes.reduce((sum, n) => sum + n.ports.filter((p) => p.deviceName).length, 0)} devices
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {/* Ring diagram */}
              <div className="overflow-x-auto">
                <RingLayout
                  ring={ring}
                  expandedNodeId={expandedNodeId}
                  onToggleNode={handleToggleNode}
                  tagStates={tagStates}
                />
              </div>

              <p className="text-xs text-center text-muted-foreground pt-1">
                Click a DPM node to view connected devices
              </p>

              {/* Expanded device grid */}
              {expandedNode && (
                <div className="border-t pt-3">
                  <StarDiagram node={expandedNode} tagStates={tagStates} />
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
