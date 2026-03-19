"use client"

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Network, ChevronDown, ChevronRight } from 'lucide-react'
import { authFetch, API_ENDPOINTS } from '@/lib/api-config'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────

interface NetworkPort {
  id: number
  nodeId: number
  portNumber: number
  cableLabel: string | null
  deviceName: string | null
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

function getStatusColor(_statusTag: string | null): StatusColor {
  // Static for now — always green. Ready for real-time PLC status later.
  if (!_statusTag) return 'gray'
  return 'green'
}

function StatusDot({ status }: { status: StatusColor }) {
  const colors = {
    green: 'bg-emerald-400 shadow-emerald-400/50',
    red: 'bg-red-500 shadow-red-500/50',
    gray: 'bg-gray-500 shadow-gray-500/30',
  }
  return (
    <span
      className={cn(
        'inline-block w-2.5 h-2.5 rounded-full shadow-sm',
        colors[status]
      )}
    />
  )
}

// ── Device type badge colors ───────────────────────────────────────

function deviceTypeBadgeClass(deviceType: string | null): string {
  switch (deviceType) {
    case 'VFD':      return 'bg-purple-600/80 text-purple-100 border-purple-500/40'
    case 'POINT_IO': return 'bg-blue-600/80 text-blue-100 border-blue-500/40'
    case 'SIO':      return 'bg-emerald-600/80 text-emerald-100 border-emerald-500/40'
    case 'FIO':      return 'bg-orange-600/80 text-orange-100 border-orange-500/40'
    default:         return 'bg-gray-600/80 text-gray-100 border-gray-500/40'
  }
}

// ── Ring SVG ───────────────────────────────────────────────────────

const SVG_W = 860
const SVG_H = 300
const NODE_W = 140
const NODE_H = 56
const MCM_W = 100
const MCM_H = 56

interface RingSvgProps {
  ring: NetworkRing
  selectedNodeId: number | null
  onSelectNode: (id: number) => void
}

function RingSvg({ ring, selectedNodeId, onSelectNode }: RingSvgProps) {
  const nodes = ring.nodes
  const topCount = Math.ceil(nodes.length / 2)
  const bottomCount = nodes.length - topCount
  const topNodes = nodes.slice(0, topCount)
  const bottomNodes = nodes.slice(topCount).reverse()

  // MCM position: left center
  const mcmX = 20
  const mcmY = (SVG_H - MCM_H) / 2

  // Layout: top row evenly spaced
  const startX = mcmX + MCM_W + 40
  const availableW = SVG_W - startX - 30
  const topSpacing = topCount > 1 ? availableW / (topCount - 1) : 0
  const topY = 20

  // Bottom row
  const bottomY = SVG_H - NODE_H - 20
  const bottomSpacing = bottomCount > 1 ? availableW / (bottomCount - 1) : 0

  function nodePos(row: 'top' | 'bottom', index: number) {
    if (row === 'top') {
      return { x: startX + index * topSpacing, y: topY }
    }
    return { x: startX + index * bottomSpacing, y: bottomY }
  }

  // Build path segments for cables
  const segments: Array<{
    x1: number; y1: number; x2: number; y2: number; label: string
  }> = []

  // MCM -> first top node
  if (topNodes.length > 0) {
    const tp = nodePos('top', 0)
    segments.push({
      x1: mcmX + MCM_W, y1: mcmY + MCM_H / 2,
      x2: tp.x, y2: tp.y + NODE_H / 2,
      label: topNodes[0].cableIn || '',
    })
  }

  // Top row: left to right
  for (let i = 0; i < topNodes.length - 1; i++) {
    const a = nodePos('top', i)
    const b = nodePos('top', i + 1)
    segments.push({
      x1: a.x + NODE_W, y1: a.y + NODE_H / 2,
      x2: b.x, y2: b.y + NODE_H / 2,
      label: topNodes[i].cableOut || '',
    })
  }

  // Top-right corner down to bottom-right
  if (topNodes.length > 0 && bottomNodes.length > 0) {
    const lastTop = nodePos('top', topCount - 1)
    const firstBottom = nodePos('bottom', 0)
    segments.push({
      x1: lastTop.x + NODE_W / 2, y1: lastTop.y + NODE_H,
      x2: firstBottom.x + NODE_W / 2, y2: firstBottom.y,
      label: topNodes[topCount - 1].cableOut || '',
    })
  }

  // Bottom row: right to left (bottomNodes is already reversed)
  for (let i = 0; i < bottomNodes.length - 1; i++) {
    const a = nodePos('bottom', i)
    const b = nodePos('bottom', i + 1)
    segments.push({
      x1: a.x, y1: a.y + NODE_H / 2,
      x2: b.x + NODE_W, y2: b.y + NODE_H / 2,
      label: bottomNodes[i].cableIn || '',
    })
  }

  // Bottom-left back to MCM
  if (bottomNodes.length > 0) {
    const lastBottom = nodePos('bottom', bottomNodes.length - 1)
    segments.push({
      x1: lastBottom.x, y1: lastBottom.y + NODE_H / 2,
      x2: mcmX + MCM_W, y2: mcmY + MCM_H / 2,
      label: bottomNodes[bottomNodes.length - 1].cableIn || '',
    })
  }

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="w-full max-w-[860px] h-auto"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Cable lines */}
      {segments.map((seg, i) => {
        const mx = (seg.x1 + seg.x2) / 2
        const my = (seg.y1 + seg.y2) / 2
        return (
          <g key={`cable-${i}`}>
            <line
              x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
              stroke="#475569" strokeWidth={2}
            />
            {seg.label && (
              <text
                x={mx} y={my - 6}
                textAnchor="middle"
                className="fill-gray-500 text-[9px]"
                fontFamily="monospace"
              >
                {seg.label}
              </text>
            )}
          </g>
        )
      })}

      {/* MCM node */}
      <g>
        <rect
          x={mcmX} y={mcmY} width={MCM_W} height={MCM_H}
          rx={8} ry={8}
          className="fill-slate-700 stroke-slate-500" strokeWidth={1.5}
        />
        <text
          x={mcmX + MCM_W / 2} y={mcmY + MCM_H / 2 - 4}
          textAnchor="middle" className="fill-white font-bold text-[12px]"
        >
          {ring.mcmName}
        </text>
        <text
          x={mcmX + MCM_W / 2} y={mcmY + MCM_H / 2 + 12}
          textAnchor="middle" className="fill-gray-400 text-[9px]"
        >
          Controller
        </text>
        <circle
          cx={mcmX + MCM_W - 10} cy={mcmY + 10} r={4}
          className="fill-emerald-400"
        />
      </g>

      {/* Top row nodes */}
      {topNodes.map((node, i) => {
        const pos = nodePos('top', i)
        const selected = selectedNodeId === node.id
        const status = getStatusColor(node.statusTag)
        return (
          <g
            key={node.id}
            className="cursor-pointer"
            onClick={() => onSelectNode(node.id)}
          >
            <rect
              x={pos.x} y={pos.y} width={NODE_W} height={NODE_H}
              rx={6} ry={6}
              className={cn(
                'stroke-[1.5px]',
                selected
                  ? 'fill-slate-600 stroke-blue-400'
                  : 'fill-slate-800 stroke-slate-600 hover:fill-slate-700'
              )}
            />
            <text
              x={pos.x + NODE_W / 2} y={pos.y + 22}
              textAnchor="middle" className="fill-white font-semibold text-[11px]"
            >
              {node.name}
            </text>
            <text
              x={pos.x + NODE_W / 2} y={pos.y + 38}
              textAnchor="middle" className="fill-gray-400 text-[9px]"
              fontFamily="monospace"
            >
              {node.ipAddress || 'No IP'}
            </text>
            <circle
              cx={pos.x + NODE_W - 10} cy={pos.y + 10} r={4}
              className={cn(
                status === 'green' && 'fill-emerald-400',
                status === 'red' && 'fill-red-500',
                status === 'gray' && 'fill-gray-500',
              )}
            />
          </g>
        )
      })}

      {/* Bottom row nodes */}
      {bottomNodes.map((node, i) => {
        const pos = nodePos('bottom', i)
        const selected = selectedNodeId === node.id
        const status = getStatusColor(node.statusTag)
        return (
          <g
            key={node.id}
            className="cursor-pointer"
            onClick={() => onSelectNode(node.id)}
          >
            <rect
              x={pos.x} y={pos.y} width={NODE_W} height={NODE_H}
              rx={6} ry={6}
              className={cn(
                'stroke-[1.5px]',
                selected
                  ? 'fill-slate-600 stroke-blue-400'
                  : 'fill-slate-800 stroke-slate-600 hover:fill-slate-700'
              )}
            />
            <text
              x={pos.x + NODE_W / 2} y={pos.y + 22}
              textAnchor="middle" className="fill-white font-semibold text-[11px]"
            >
              {node.name}
            </text>
            <text
              x={pos.x + NODE_W / 2} y={pos.y + 38}
              textAnchor="middle" className="fill-gray-400 text-[9px]"
              fontFamily="monospace"
            >
              {node.ipAddress || 'No IP'}
            </text>
            <circle
              cx={pos.x + NODE_W - 10} cy={pos.y + 10} r={4}
              className={cn(
                status === 'green' && 'fill-emerald-400',
                status === 'red' && 'fill-red-500',
                status === 'gray' && 'fill-gray-500',
              )}
            />
          </g>
        )
      })}
    </svg>
  )
}

// ── Star topology (port list) ──────────────────────────────────────

function PortGrid({ node }: { node: NetworkNode }) {
  const connectedPorts = node.ports.filter(p => p.deviceName)
  const emptyCount = node.totalPorts - connectedPorts.length

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span className="font-semibold text-white">{node.name}</span>
        <span>-</span>
        <span>{connectedPorts.length} connected</span>
        <span className="text-gray-600">/ {node.totalPorts} total ports</span>
        {node.ipAddress && (
          <span className="ml-auto font-mono text-xs text-gray-500">{node.ipAddress}</span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
        {connectedPorts.map((port) => {
          const status = getStatusColor(port.statusTag)
          return (
            <div
              key={port.id}
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700/50"
            >
              <span className="text-xs font-mono text-gray-500 w-8 shrink-0">
                P{String(port.portNumber).padStart(2, '0')}
              </span>
              <span className="text-xs font-mono text-gray-500 w-12 shrink-0">
                {port.cableLabel || '---'}
              </span>
              <span className="text-sm text-white truncate flex-1" title={port.deviceName || ''}>
                {port.deviceName}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] px-1.5 py-0 h-5 shrink-0',
                  deviceTypeBadgeClass(port.deviceType)
                )}
              >
                {port.deviceType || '?'}
              </Badge>
              <StatusDot status={status} />
            </div>
          )
        })}
      </div>

      {emptyCount > 0 && (
        <p className="text-xs text-gray-600">
          + {emptyCount} empty/spare ports
        </p>
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
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null)

  useEffect(() => {
    async function fetchTopology() {
      setLoading(true)
      setError(null)
      try {
        const params = subsystemId ? `?subsystemId=${subsystemId}` : ''
        const res = await authFetch(`${API_ENDPOINTS.networkTopology}${params}`)
        const data: TopologyResponse = await res.json()
        if (data.success) {
          setRings(data.rings)
        } else {
          setError(data.error || 'Failed to load topology')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error')
      } finally {
        setLoading(false)
      }
    }
    fetchTopology()
  }, [subsystemId])

  function handleSelectNode(nodeId: number) {
    setSelectedNodeId(prev => prev === nodeId ? null : nodeId)
  }

  // Find the selected node across all rings
  const selectedNode = rings
    .flatMap(r => r.nodes)
    .find(n => n.id === selectedNodeId) || null

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400 mr-2" />
        <span className="text-gray-400">Loading network topology...</span>
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
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <Network className="w-10 h-10 mb-2" />
        <p>No network topology data found.</p>
        <p className="text-sm mt-1">Run the network seed script to populate data.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {rings.map((ring) => (
        <Card key={ring.id} className="bg-slate-900 border-slate-700">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg text-white">
              <Network className="w-5 h-5 text-blue-400" />
              {ring.name}
              <Badge variant="outline" className="ml-2 text-xs text-gray-400 border-gray-600">
                {ring.nodes.length} nodes
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Ring diagram */}
            <div className="flex justify-center overflow-x-auto pb-2">
              <RingSvg
                ring={ring}
                selectedNodeId={selectedNodeId}
                onSelectNode={handleSelectNode}
              />
            </div>

            <p className="text-xs text-center text-gray-500">
              Click a node to view its port connections
            </p>

            {/* Star topology expansion */}
            {ring.nodes.map((node) => {
              const isExpanded = selectedNodeId === node.id
              return (
                <div key={node.id}>
                  <button
                    onClick={() => handleSelectNode(node.id)}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors',
                      isExpanded
                        ? 'bg-slate-700/60 border border-blue-500/30'
                        : 'bg-slate-800/40 border border-slate-700/30 hover:bg-slate-800/60'
                    )}
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-blue-400 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-white">{node.name}</span>
                    <StatusDot status={getStatusColor(node.statusTag)} />
                    <span className="text-xs text-gray-500 ml-auto">
                      {node.ports.filter(p => p.deviceName).length} devices
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="mt-2 ml-6 pb-2">
                      <PortGrid node={node} />
                    </div>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
