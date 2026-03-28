"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Network, ChevronDown, ChevronRight, X, RefreshCw, Search, Copy, Check } from 'lucide-react'
import { authFetch, API_ENDPOINTS } from '@/lib/api-config'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────

interface NetworkPort {
  id: number
  nodeId: number
  portNumber: string
  cableLabel: string | null
  deviceName: string | null
  deviceIp: string | null
  deviceType: string | null
  statusTag: string | null
  parentPortId: number | null
  subPorts?: NetworkPort[]
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

type StatusColor = 'green' | 'red' | 'gray'

// tagStates: map of tagName → faulted (true = faulted/red, false = healthy/green, null = can't read)
function getStatusColor(statusTag: string | null, tagStates: Record<string, boolean | null>): StatusColor {
  if (!statusTag) return 'gray'     // No tag configured — not monitored
  const value = tagStates[statusTag]
  if (value === undefined) return 'gray'   // Tag not yet polled (first load)
  if (value === null) return 'gray'        // Tag configured but can't read
  return value ? 'red' : 'green'           // ConnectionFaulted: true = faulted, false = healthy
}

function statusToHex(s: StatusColor): string {
  if (s === 'green') return '#22c55e'
  if (s === 'red') return '#ef4444'
  return 'hsl(var(--muted))'
}

function StatusDot({ status, size = 'sm' }: { status: StatusColor; size?: 'sm' | 'md' }) {
  const colors = {
    green: 'bg-emerald-400 shadow-emerald-400/50',
    red: 'bg-red-500 shadow-red-500/50',
    gray: 'bg-gray-500 shadow-gray-500/30',
  }
  const sizeClass = size === 'md' ? 'w-3 h-3' : 'w-2.5 h-2.5'
  return (
    <span className={cn('inline-block rounded-full shadow-sm', sizeClass, colors[status])} />
  )
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
      title={`Copy "${text}"`}
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
    </button>
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
  const NODES_PER_ROW = 4
  const NODE_COLS = NODES_PER_ROW + 1 // MCM + 4 node columns
  const totalRows = Math.ceil(nodes.length / NODES_PER_ROW)

  const containerRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const [paths, setPaths] = useState<string[]>([])
  const [arrowHeads, setArrowHeads] = useState<{ x: number; y: number; angle: number }[]>([])

  // Logical column for each node (1-based, MCM=1)
  const getLogCol = (nodeIdx: number) => {
    const rowIdx = Math.floor(nodeIdx / NODES_PER_ROW)
    const posInRow = nodeIdx % NODES_PER_ROW
    return rowIdx % 2 === 0 ? posInRow + 2 : NODE_COLS - posInRow
  }
  const getLogRow = (nodeIdx: number) => Math.floor(nodeIdx / NODES_PER_ROW) + 1

  // Measure DOM and compute SVG paths
  useEffect(() => {
    const measure = () => {
      const container = containerRef.current
      if (!container) return
      const cRect = container.getBoundingClientRect()

      const getCenter = (key: string) => {
        const el = nodeRefs.current.get(key)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2 - cRect.left, y: r.top + r.height / 2 - cRect.top, w: r.width, h: r.height }
      }

      // Build ordered list: MCM, node0, node1, ..., nodeN, then return to MCM
      const allKeys = ['mcm', ...nodes.map((_, i) => `node-${i}`)]
      const centers = allKeys.map(k => getCenter(k)).filter(Boolean) as { x: number; y: number; w: number; h: number }[]

      if (centers.length < 2) return

      const newPaths: string[] = []
      const newArrows: { x: number; y: number; angle: number }[] = []

      for (let i = 0; i < centers.length - 1; i++) {
        const from = centers[i]
        const to = centers[i + 1]
        const fromRow = i === 0 ? 1 : getLogRow(i - 1)
        const toRow = i === 0 ? 1 : getLogRow(i)

        if (fromRow === toRow) {
          // Horizontal: edge of card to edge of next card
          const dir = to.x > from.x ? 1 : -1
          const x1 = from.x + dir * (from.w / 2 + 2)
          const x2 = to.x - dir * (to.w / 2 + 2)
          newPaths.push(`M${x1},${from.y} L${x2},${to.y}`)
          const angle = dir > 0 ? 0 : 180
          newArrows.push({ x: x2, y: to.y, angle })
        } else {
          // Vertical turn: go down from bottom of card, then across to next card
          const x1 = from.x
          const y1 = from.y + from.h / 2 + 2
          const x2 = to.x
          const y2 = to.y - to.h / 2 - 2
          const yMid = (y1 + y2) / 2
          newPaths.push(`M${x1},${y1} L${x1},${yMid} L${x2},${yMid} L${x2},${y2}`)
          newArrows.push({ x: x2, y: y2, angle: 90 })
        }
      }

      // Return path: last node → back to MCM
      if (centers.length > 2) {
        const last = centers[centers.length - 1]
        const mcm = centers[0]
        const lastLogRow = getLogRow(nodes.length - 1)

        if (lastLogRow === 1) {
          // Same row as MCM — go down, left, up
          const margin = 24
          const x1 = last.x
          const y1 = last.y + last.h / 2 + 2
          const yBottom = y1 + margin
          const x2 = mcm.x
          const y2 = mcm.y + mcm.h / 2 + 2
          newPaths.push(`M${x1},${y1} L${x1},${yBottom} L${x2},${yBottom} L${x2},${y2}`)
          newArrows.push({ x: x2, y: y2, angle: -90 })
        } else {
          // Different row — go left to MCM column, then up
          const dir = last.x > mcm.x ? -1 : 1
          const x1 = last.x + dir * (last.w / 2 + 2)
          const xMcm = mcm.x
          const yLast = last.y
          const y2 = mcm.y + mcm.h / 2 + 2
          newPaths.push(`M${x1},${yLast} L${xMcm},${yLast} L${xMcm},${y2}`)
          newArrows.push({ x: xMcm, y: y2, angle: -90 })
        }
      }

      setPaths(newPaths)
      setArrowHeads(newArrows)
    }

    measure()
    const timer = setTimeout(measure, 100)
    window.addEventListener('resize', measure)
    return () => { clearTimeout(timer); window.removeEventListener('resize', measure) }
  }, [nodes.length, expandedNodeId])

  const renderNode = (node: typeof nodes[0]) => {
    const isExpanded = expandedNodeId === node.id
    const status = getStatusColor(node.statusTag, tagStates)
    const deviceCount = node.ports.filter((p) => p.deviceName).length
    return (
      <button
        onClick={() => onToggleNode(node.id)}
        className={cn(
          'w-full relative rounded-lg border-2 px-4 py-3 text-center transition-all',
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
        <Badge variant="outline" className="mt-1.5 text-[10px] border-border text-muted-foreground">
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
    )
  }

  return (
    <div className="relative px-4 pt-4 pb-8 overflow-x-auto" ref={containerRef}>
      {/* SVG overlay for all connection paths */}
      <svg
        className="absolute inset-0 pointer-events-none"
        width="100%"
        height="100%"
        style={{ overflow: 'visible' }}
      >
        <defs>
          <marker id="ring-arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse">
            <path d="M0,1 L7,4 L0,7 Z" fill="rgba(16,185,129,0.6)" />
          </marker>
        </defs>
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="rgba(16,185,129,0.45)" strokeWidth="2" strokeDasharray="8 5" />
        ))}
        {arrowHeads.map((a, i) => (
          <g key={`ah-${i}`} transform={`translate(${a.x},${a.y}) rotate(${a.angle})`}>
            <polygon points="-6,-4 2,0 -6,4" fill="rgba(16,185,129,0.6)" />
          </g>
        ))}
      </svg>

      {/* Node grid */}
      <div
        className="grid items-center relative"
        style={{
          gridTemplateColumns: `repeat(${NODE_COLS}, minmax(150px, 1fr))`,
          gap: '28px 48px',
        }}
      >
        {/* MCM Controller — row 1, col 1 */}
        <div
          ref={(el) => { nodeRefs.current.set('mcm', el) }}
          style={{ gridRow: 1, gridColumn: 1 }}
        >
          <div className="relative rounded-lg border-2 border-blue-500/50 bg-blue-500/10 px-4 py-3 text-center">
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

        {/* DPM Nodes */}
        {nodes.map((node, idx) => (
          <div
            key={node.id}
            ref={(el) => { nodeRefs.current.set(`node-${idx}`, el) }}
            style={{ gridRow: getLogRow(idx), gridColumn: getLogCol(idx) }}
          >
            {renderNode(node)}
          </div>
        ))}
      </div>
    </div>
  )
}


// ── Pannable/Zoomable viewport (Ctrl+wheel to zoom, drag to pan) ──

function useViewport(containerRef: React.RefObject<HTMLDivElement | null>) {
  const zoomRef = useRef(1)
  const panRef = useRef({ x: 0, y: 0 })
  const [, forceRender] = useState(0)
  const dragging = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })

  const update = useCallback(() => forceRender((n) => n + 1), [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      // Capture all scroll inside the viewport for zoom — page doesn't scroll
      e.preventDefault()
      e.stopPropagation()
      const rect = el.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const oldZoom = zoomRef.current
      const delta = e.deltaY > 0 ? -0.08 : 0.08
      const newZoom = Math.min(3, Math.max(0.15, oldZoom + delta))
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

// ── FIOM Sub-diagram ─────────────────────────────────────────────

interface FiomPort {
  portNum: number
  pins: { pin: number; type: string; ioName: string; description: string }[]
}

function FiomDiagram({ fiomPort, tagStates }: { fiomPort: NetworkPort; tagStates: Record<string, boolean | null> }) {
  const fiomName = fiomPort.deviceName || ''
  const subPorts = fiomPort.subPorts || []

  if (subPorts.length === 0) return <div className="py-8 text-center text-sm text-muted-foreground">No sub-devices found for {fiomName}</div>

  const connectedPorts = subPorts.filter(p => p.deviceName).sort((a, b) => {
    const aNum = parseInt(a.portNumber.replace('X', ''))
    const bNum = parseInt(b.portNumber.replace('X', ''))
    return aNum - bNum
  })

  function portStatus(port: NetworkPort): 'green' | 'red' | 'gray' {
    return getStatusColor(port.statusTag, tagStates)
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground px-1">
        {connectedPorts.length} connected devices
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {connectedPorts.map((port) => {
          const s = portStatus(port)
          const color = statusToHex(s)
          const borderClass = s === 'green' ? 'border-green-500/60' : s === 'red' ? 'border-red-500/60' : 'border-border'
          return (
            <div key={port.id} className={cn("rounded-lg border-2 overflow-hidden bg-card", borderClass)}>
              {/* Header */}
              <div className="bg-blue-500 px-3 py-1.5 flex items-center justify-between">
                <span className="text-[10px] font-bold text-white">{port.portNumber}</span>
                <div className={cn("w-2 h-2 rounded-full", s === 'green' ? 'bg-green-400' : s === 'red' ? 'bg-red-400' : 'bg-gray-400')} />
              </div>
              {/* Body */}
              <div className="px-3 py-2">
                <p className="text-xs font-bold text-foreground truncate" title={port.deviceName || ''}>{port.deviceName}</p>
                {port.deviceIp && <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{port.deviceIp}</p>}
                {port.statusTag && <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5 truncate" title={port.statusTag}>{port.statusTag}</p>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Star Diagram: thin vertical device cards, distance-sorted lanes ─

// All devices use blue for the header strip
const DEVICE_HEADER_COLOR = '#3b82f6'

function StarDiagram({ node, tagStates, subsystemId }: { node: NetworkNode; tagStates: Record<string, boolean | null>; subsystemId?: number }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const vp = useViewport(viewportRef)
  const [selectedDevice, setSelectedDevice] = useState<{ name: string; type: string; ip: string; port: number | string; x: number; y: number } | null>(null)
  const [expandedFiom, setExpandedFiom] = useState<NetworkPort | null>(null)

  const FIRST_VISIBLE_PORT = 5 // skip ports 1-4 (unreachable)
  const connectedPorts = node.ports
    .filter((p) => p.deviceName && !p.parentPortId && parseInt(p.portNumber) >= FIRST_VISIBLE_PORT)
    .sort((a, b) => parseInt(a.portNumber) - parseInt(b.portNumber))
  const totalPorts = node.totalPorts
  const visiblePortCount = totalPorts - FIRST_VISIBLE_PORT + 1

  // ── Device cards in a grid: max 4 per row ──
  const COLS = 4
  const DEVICE_W = 140
  const DEVICE_H = 56
  const DEVICE_GAP_X = 16
  const DEVICE_GAP_Y = 32 // extra space for port number box below each card
  const deviceRows = Math.ceil(connectedPorts.length / COLS)

  // Device grid position (row, col) → (x, y)
  function devPos(devIdx: number) {
    const col = devIdx % COLS
    const row = Math.floor(devIdx / COLS)
    return {
      x: 20 + col * (DEVICE_W + DEVICE_GAP_X) + DEVICE_W / 2,
      y: 10 + row * (DEVICE_H + DEVICE_GAP_Y) + DEVICE_H / 2,
    }
  }

  const gridW = Math.min(connectedPorts.length, COLS) * (DEVICE_W + DEVICE_GAP_X) - DEVICE_GAP_X + 40
  const gridH = deviceRows * (DEVICE_H + DEVICE_GAP_Y) - DEVICE_GAP_Y

  // DPM block below the device grid
  const DPM_PORT_R = 18
  const DPM_PORT_ROWS = 4
  const DPM_PORT_COLS = Math.ceil(visiblePortCount / DPM_PORT_ROWS)
  const DPM_PORT_SPACE_X = 52
  const DPM_PORT_SPACE_Y = 52
  const DPM_PAD_X = 32
  const DPM_PAD_TOP = 24
  const DPM_PAD_BOT = 24
  const dpmW = DPM_PAD_X * 2 + (DPM_PORT_COLS - 1) * DPM_PORT_SPACE_X + DPM_PORT_R * 2
  const dpmH = DPM_PAD_TOP + (DPM_PORT_ROWS - 1) * DPM_PORT_SPACE_Y + DPM_PORT_R * 2 + DPM_PAD_BOT

  const totalW = Math.max(gridW, dpmW) + 60
  const dpmX = totalW / 2 - dpmW / 2

  // Y positions
  const DEVICE_Y_START = 10
  const DPM_LABEL_H = 36
  const DPM_Y = DEVICE_Y_START + gridH + 40 + DPM_LABEL_H
  const totalH = DPM_Y + dpmH + 20

  // DPM port position
  function dpmPortPos(portNum: number) {
    const idx = portNum - FIRST_VISIBLE_PORT
    const col = Math.floor(idx / DPM_PORT_ROWS)
    const row = idx % DPM_PORT_ROWS
    return {
      x: dpmX + DPM_PAD_X + DPM_PORT_R + col * DPM_PORT_SPACE_X,
      y: DPM_Y + DPM_PAD_TOP + DPM_PORT_R + row * DPM_PORT_SPACE_Y,
    }
  }

  // Only show ports 5 and above
  const allPorts = Array.from({ length: visiblePortCount }, (_, i) =>
    node.ports.find((p) => Number(p.portNumber) === i + FIRST_VISIBLE_PORT) || null
  )

  return (
    <div className="flex flex-col h-full">
      <div className="text-center py-1.5 text-sm font-semibold text-foreground border-b flex-shrink-0">
        {node.name} <span className="text-xs font-normal text-muted-foreground ml-1">{connectedPorts.length} devices{node.ipAddress ? ` · ${node.ipAddress}` : ''}</span>
      </div>
      {/* Viewport — scroll to zoom, drag to pan */}
      <div
        ref={viewportRef}
        className="relative overflow-hidden cursor-grab active:cursor-grabbing select-none flex-1 min-h-0"
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
          {/* ── clipPath defs for device cards ── */}
          <defs>
            {connectedPorts.map((port, devIdx) => {
              const { x: cx, y: cy } = devPos(devIdx)
              return (
                <clipPath key={`clip-dpm-${port.id}`} id={`clip-dpm-${port.id}`}>
                  <rect x={cx - DEVICE_W / 2} y={cy - DEVICE_H / 2} width={DEVICE_W} height={DEVICE_H} rx={4} />
                </clipPath>
              )
            })}
          </defs>


          {/* ── Device cards in grid layout ── */}
          {connectedPorts.map((port, devIdx) => {
            const { x: cx, y: cy } = devPos(devIdx)
            const DEVICE_Y = cy - DEVICE_H / 2
            const deviceType = getDeviceType(port.deviceName || '')
            const isFiomDevice = deviceType === 'FIOM'
            const headerColor = DEVICE_HEADER_COLOR
            const s = getStatusColor(port.statusTag, tagStates)
            const bodyColor = statusToHex(s)

            return (
              <g key={`dev-${port.id}`} className="cursor-pointer" onClick={(e) => {
                e.stopPropagation()
                const isFiom = deviceType === 'FIOM'
                if (isFiom) {
                  // Build the port with subPorts from all ports on this node that have parentPortId = this port's id
                  const fiomWithSubs = { ...port, subPorts: node.ports.filter(p => p.parentPortId === port.id) }
                  setExpandedFiom(prev => prev?.id === port.id ? null : fiomWithSubs)
                  setSelectedDevice(null)
                } else {
                  const rect = viewportRef.current?.getBoundingClientRect()
                  if (rect) setSelectedDevice({
                    name: port.deviceName || '',
                    type: deviceType,
                    ip: port.deviceIp || 'No IP',
                    port: port.portNumber,
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                  })
                }
              }}>
                {/* Full card background */}
                <rect x={cx - DEVICE_W / 2} y={DEVICE_Y} width={DEVICE_W} height={DEVICE_H} rx={4} fill="hsl(var(--card))" />
                {/* Body border — status color */}
                <rect x={cx - DEVICE_W / 2} y={DEVICE_Y} width={DEVICE_W} height={DEVICE_H} rx={4}
                  fill="none" stroke={bodyColor} strokeWidth={1.5} strokeOpacity={0.7}
                />
                {/* Blue header — top with rounded top corners */}
                <path
                  d={`M ${cx - DEVICE_W / 2 + 4} ${DEVICE_Y}
                      Q ${cx - DEVICE_W / 2} ${DEVICE_Y} ${cx - DEVICE_W / 2} ${DEVICE_Y + 4}
                      L ${cx - DEVICE_W / 2} ${DEVICE_Y + 18}
                      L ${cx + DEVICE_W / 2} ${DEVICE_Y + 18}
                      L ${cx + DEVICE_W / 2} ${DEVICE_Y + 4}
                      Q ${cx + DEVICE_W / 2} ${DEVICE_Y} ${cx + DEVICE_W / 2 - 4} ${DEVICE_Y}
                      Z`}
                  fill={headerColor}
                />
                <text x={cx - DEVICE_W / 2 + 6} y={DEVICE_Y + 12} textAnchor="start" fontSize={8} fontWeight="bold" fill="#fff">
                  {deviceType}
                </text>
                <text x={cx + DEVICE_W / 2 - 6} y={DEVICE_Y + 12} textAnchor="end" fontSize={7} fill="rgba(255,255,255,0.7)" fontFamily="monospace">
                  P{port.portNumber}
                </text>
                {/* Device name — horizontal, clipped to card bounds */}
                <g clipPath={`url(#clip-dpm-${port.id})`}>
                  <text
                    x={cx} y={DEVICE_Y + 34}
                    textAnchor="middle"
                    fontSize={9} fontWeight="bold" fill="#ffffff"
                  >
                    {port.deviceName}
                  </text>
                  {port.deviceIp && (
                    <text x={cx} y={DEVICE_Y + 48} textAnchor="middle" fontSize={7} fill="hsl(var(--muted-foreground))">
                      {port.deviceIp}
                    </text>
                  )}
                </g>
                {/* Port number box below card */}
                <rect x={cx - 14} y={DEVICE_Y + DEVICE_H + 4} width={28} height={18} rx={3}
                  fill={bodyColor} fillOpacity={0.8}
                />
                <text x={cx} y={DEVICE_Y + DEVICE_H + 16} textAnchor="middle" fontSize={9} fontWeight="bold" fontFamily="monospace" fill="#ffffff">
                  {port.portNumber}
                </text>
              </g>
            )
          })}

          {/* ── FIOM sub-device badges (rendered on top of all cards) ── */}
          {connectedPorts.map((port, devIdx) => {
            const deviceType = getDeviceType(port.deviceName || '')
            if (deviceType !== 'FIOM') return null
            const subCount = node.ports.filter(p => p.parentPortId === port.id).length
            if (subCount === 0) return null
            const { x: cx, y: cy } = devPos(devIdx)
            const badgeX = cx + DEVICE_W / 2 - 2
            const badgeY = cy - DEVICE_H / 2 - 2
            const isOpen = expandedFiom?.id === port.id
            return (
              <g key={`fiom-badge-${port.id}`}>
                <circle cx={badgeX} cy={badgeY} r={9} fill={isOpen ? '#3b82f6' : '#f59e0b'} />
                <text x={badgeX} y={badgeY + 3.5} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#fff">
                  {subCount}
                </text>
                {!isOpen && (
                  <circle cx={badgeX} cy={badgeY} r={9} fill="none" stroke="#f59e0b" strokeWidth={2}>
                    <animate attributeName="r" values="9;13;9" dur="1.5s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="1;0;1" dur="1.5s" repeatCount="indefinite" />
                  </circle>
                )}
              </g>
            )
          })}

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
            const portNum = i + FIRST_VISIBLE_PORT
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
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-sm text-foreground">{selectedDevice.name}</span>
                <CopyBtn text={selectedDevice.name} />
              </div>
              <button onClick={() => setSelectedDevice(null)} className="text-muted-foreground hover:text-foreground p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>Type: <span className="font-medium text-blue-500">{selectedDevice.type}</span></p>
              <p className="flex items-center gap-1">IP: <span className="font-mono text-foreground">{selectedDevice.ip}</span> {selectedDevice.ip !== 'No IP' && <CopyBtn text={selectedDevice.ip} />}</p>
              <p className="flex items-center gap-1">Port: <span className="font-mono text-foreground">{selectedDevice.port}</span> <CopyBtn text={String(selectedDevice.port)} /></p>
            </div>
          </div>
        )}
      </div>

      {/* FIOM modal */}
      {expandedFiom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setExpandedFiom(null)}>
          <div className="relative bg-card border rounded-xl shadow-2xl w-[90vw] max-w-[900px] max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b bg-card/95 backdrop-blur-sm">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-foreground">{expandedFiom.deviceName}</span>
                <Badge variant="outline" className="text-[10px]">FIBER I/O MODULE</Badge>
                <span className="text-xs text-muted-foreground font-mono">{expandedFiom.deviceIp}</span>
              </div>
              <button onClick={() => setExpandedFiom(null)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4">
              <FiomDiagram fiomPort={expandedFiom} tagStates={tagStates} />
            </div>
          </div>
        </div>
      )}
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
  // Device table always visible in right panel
  const [tableSearch, setTableSearch] = useState('')

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

  const [refreshing, setRefreshing] = useState(false)

  const fetchTopology = async (pullFromCloud = false) => {
    setLoading(true)
    setError(null)
    try {
      const params = subsystemId ? `?subsystemId=${subsystemId}` : ''

      // If explicitly refreshing, pull from cloud first
      if (pullFromCloud) {
        setRefreshing(true)
        try {
          await authFetch('/api/cloud/pull-network', { method: 'POST' })
        } catch {
          // Cloud pull failed — fall through to show local data
        }
        setRefreshing(false)
      }

      // Fetch local data
      const res = await authFetch(`${API_ENDPOINTS.networkTopology}${params}`)
      const data: TopologyResponse = await res.json()

      if (data.success && data.rings.length > 0) {
        setRings(data.rings)
        return
      }

      // No local data — try pulling from cloud automatically
      if (!pullFromCloud) {
        try {
          const pullRes = await authFetch('/api/cloud/pull-network', { method: 'POST' })
          const pullData = await pullRes.json()

          if (pullData.success && pullData.rings > 0) {
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
      }

      setRings([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
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
        <p className="text-sm mt-1">Network data is pulled automatically from the cloud when available.</p>
      </div>
    )
  }

  // Flatten all devices for the table
  const allDevices = rings.flatMap(ring =>
    ring.nodes.flatMap(node =>
      node.ports
        .filter(p => p.deviceName)
        .map(port => ({
          ringName: ring.name,
          dpmName: node.name,
          dpmIp: node.ipAddress,
          portNumber: port.portNumber,
          deviceName: port.deviceName!,
          deviceIp: port.deviceIp,
          deviceType: port.deviceType,
          statusTag: port.statusTag,
          status: getStatusColor(port.statusTag, tagStates),
        }))
    )
  )

  const filteredDevices = tableSearch
    ? allDevices.filter(d =>
        d.deviceName.toLowerCase().includes(tableSearch.toLowerCase()) ||
        d.dpmName.toLowerCase().includes(tableSearch.toLowerCase()) ||
        (d.deviceType || '').toLowerCase().includes(tableSearch.toLowerCase()) ||
        (d.deviceIp || '').includes(tableSearch) ||
        (d.statusTag || '').toLowerCase().includes(tableSearch.toLowerCase())
      )
    : allDevices

  const statusCounts = {
    healthy: allDevices.filter(d => d.status === 'green').length,
    faulted: allDevices.filter(d => d.status === 'red').length,
    unknown: allDevices.filter(d => d.status === 'gray').length,
  }

  // Devices for the expanded DPM
  const expandedNode = rings.flatMap(r => r.nodes).find(n => n.id === expandedNodeId) || null
  const dpmDevices = expandedNode
    ? expandedNode.ports
        .filter(p => p.deviceName)
        .sort((a, b) => parseInt(a.portNumber) - parseInt(b.portNumber))
        .map(port => ({
          portNumber: port.portNumber,
          deviceName: port.deviceName!,
          deviceIp: port.deviceIp,
          deviceType: port.deviceType,
          statusTag: port.statusTag,
          status: getStatusColor(port.statusTag, tagStates),
        }))
    : []

  const filteredDpmDevices = tableSearch
    ? dpmDevices.filter(d =>
        d.deviceName.toLowerCase().includes(tableSearch.toLowerCase()) ||
        (d.deviceType || '').toLowerCase().includes(tableSearch.toLowerCase()) ||
        (d.deviceIp || '').includes(tableSearch) ||
        (d.statusTag || '').toLowerCase().includes(tableSearch.toLowerCase())
      )
    : dpmDevices

  return (
    <div className="flex flex-col h-full gap-4 pt-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            {statusCounts.healthy} healthy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
            {statusCounts.faulted} faulted
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-gray-500" />
            {statusCounts.unknown} unknown
          </span>
        </div>
        <button
          onClick={() => fetchTopology(true)}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border bg-card hover:bg-accent transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing..." : "Refresh from Cloud"}
        </button>
      </div>

      {/* Ring diagrams — full width */}
      {rings.map((ring) => (
        <Card key={ring.id} className="bg-card border flex-shrink-0 overflow-hidden">
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
          <CardContent>
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
          </CardContent>
        </Card>
      ))}

      {/* Expanded DPM: Star diagram (left half) + Device table (right half) */}
      {expandedNode && (
        <div className="flex border rounded-lg overflow-hidden flex-1 min-h-0">
          {/* Left: Star diagram */}
          <div className="flex-1 min-w-0 flex flex-col">
            <StarDiagram node={expandedNode} tagStates={tagStates} subsystemId={subsystemId} />
          </div>

          {/* Right: Device table */}
          <div className="w-1/2 flex-shrink-0 border-l flex flex-col overflow-hidden">
            <div className="p-3 border-b space-y-2">
              <h3 className="font-semibold text-sm">{expandedNode.name} — {dpmDevices.length} devices</h3>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search devices..."
                  value={tableSearch}
                  onChange={e => setTableSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card border-b">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium w-6"></th>
                    <th className="px-2 py-2 font-medium">Device</th>
                    <th className="px-2 py-2 font-medium">Status Tag</th>
                    <th className="px-2 py-2 font-medium">Type</th>
                    <th className="px-2 py-2 font-medium">Port</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDpmDevices.map((device, i) => (
                    <tr
                      key={`${device.portNumber}-${i}`}
                      className="border-b border-border/50 hover:bg-accent/50 transition-colors"
                    >
                      <td className="px-3 py-2">
                        <span className={cn(
                          "block w-2.5 h-2.5 rounded-full",
                          device.status === 'green' && "bg-green-500",
                          device.status === 'red' && "bg-red-500",
                          device.status === 'gray' && "bg-gray-500",
                        )} />
                      </td>
                      <td className="px-2 py-2">
                        <div className="font-medium text-foreground truncate max-w-[140px]" title={device.deviceName}>
                          {device.deviceName}
                        </div>
                        {device.deviceIp && (
                          <div className="text-muted-foreground text-[10px] font-mono">{device.deviceIp}</div>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {device.statusTag ? (
                          <span className="font-mono text-[10px] text-muted-foreground truncate block max-w-[140px]" title={device.statusTag}>
                            {device.statusTag}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {device.deviceType && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {device.deviceType}
                          </Badge>
                        )}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground text-center">
                        {device.portNumber}
                      </td>
                    </tr>
                  ))}
                  {filteredDpmDevices.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                        {tableSearch ? "No devices match" : "No devices"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
