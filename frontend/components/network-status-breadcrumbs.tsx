"use client"

import { useState, useEffect, useCallback } from "react"
import { CheckCircle, XCircle, AlertCircle, Circle, Loader2, Cloud, Server, Cpu, Box, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { API_ENDPOINTS } from "@/lib/api-config"

type NetworkNodeStatus = "connected" | "disconnected" | "warning" | "unknown" | "loading"

interface NetworkNode {
  name: string
  label: string
  status: NetworkNodeStatus
  statusCode?: string
  message?: string
  icon: React.ReactNode
  badge?: string
}

interface NetworkChainStatus {
  cloud: { connected: boolean; message?: string }
  backend: { connected: boolean; message?: string }
  plc: { connected: boolean; ip?: string; path?: string; message?: string }
  module: {
    name: string
    connected: boolean
    deviceType?: string
    ipAddress?: string
    totalTags?: number
    respondingTags?: number
    errorCount?: number
    parentDevice?: string
    message?: string
  }
  ioPoint: { name: string; connected: boolean; statusCode?: string; message?: string }
}

interface NetworkStatusBreadcrumbsProps {
  tagName?: string
  className?: string
}

export function NetworkStatusBreadcrumbs({ tagName, className }: NetworkStatusBreadcrumbsProps) {
  const [chainStatus, setChainStatus] = useState<NetworkChainStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)

  const fetchNetworkStatus = useCallback(async () => {
    try {
      const url = tagName
        ? `${API_ENDPOINTS.networkChainStatus}?tagName=${encodeURIComponent(tagName)}`
        : API_ENDPOINTS.networkChainStatus

      const response = await fetch(url)
      if (response.ok) {
        const data = await response.json()
        setChainStatus(data)
      }
    } catch (err) {
      console.error('Error fetching network status:', err)
    } finally {
      setLoading(false)
    }
  }, [tagName])

  useEffect(() => {
    fetchNetworkStatus()
    // Poll every 5s as fallback (SignalR will provide faster updates when available)
    const interval = setInterval(fetchNetworkStatus, 5000)
    return () => clearInterval(interval)
  }, [fetchNetworkStatus])

  const getStatusColor = (status: NetworkNodeStatus) => {
    switch (status) {
      case "connected":
        return "bg-green-500"
      case "disconnected":
        return "bg-red-500"
      case "warning":
        return "bg-yellow-500"
      default:
        return "bg-gray-400"
    }
  }

  const getStatusIcon = (status: NetworkNodeStatus) => {
    switch (status) {
      case "connected":
        return <CheckCircle className="w-3.5 h-3.5 text-green-500" />
      case "disconnected":
        return <XCircle className="w-3.5 h-3.5 text-red-500" />
      case "warning":
        return <AlertCircle className="w-3.5 h-3.5 text-yellow-500" />
      case "loading":
        return <Loader2 className="w-3.5 h-3.5 text-gray-400 animate-spin" />
      default:
        return <Circle className="w-3.5 h-3.5 text-gray-400" />
    }
  }

  const buildNodes = (): NetworkNode[] => {
    if (!chainStatus) {
      // Show only Cloud/Backend/PLC when loading (without tag-specific nodes)
      const baseNodes: NetworkNode[] = [
        { name: "cloud", label: "Cloud", status: "loading", icon: <Cloud className="w-4 h-4" /> },
        { name: "backend", label: "Backend", status: "loading", icon: <Server className="w-4 h-4" /> },
        { name: "plc", label: "PLC", status: "loading", icon: <Cpu className="w-4 h-4" /> },
      ]
      if (tagName) {
        baseNodes.push(
          { name: "module", label: "Module", status: "loading", icon: <Box className="w-4 h-4" /> },
          { name: "io", label: "I/O", status: "loading", icon: <Radio className="w-4 h-4" /> }
        )
      } else {
        baseNodes.push(
          { name: "modules", label: "Modules", status: "loading", icon: <Box className="w-4 h-4" /> }
        )
      }
      return baseNodes
    }

    const nodes: NetworkNode[] = [
      {
        name: "cloud",
        label: "Cloud",
        status: chainStatus.cloud.connected ? "connected" : "disconnected",
        message: chainStatus.cloud.message || (chainStatus.cloud.connected ? "Connected to cloud server" : "Cloud disconnected"),
        icon: <Cloud className="w-4 h-4" />
      },
      {
        name: "backend",
        label: "Backend",
        status: chainStatus.backend.connected ? "connected" : "disconnected",
        message: chainStatus.backend.message || "Local server running",
        icon: <Server className="w-4 h-4" />
      },
      {
        name: "plc",
        label: "PLC",
        status: chainStatus.plc.connected ? "connected" : "disconnected",
        statusCode: chainStatus.plc.connected ? undefined : "ERR_CONNECTION",
        message: chainStatus.plc.message || (chainStatus.plc.connected
          ? `Connected to ${chainStatus.plc.ip}`
          : `Cannot reach PLC at ${chainStatus.plc.ip}`),
        icon: <Cpu className="w-4 h-4" />
      },
    ]

    if (tagName) {
      // Tag-specific: show individual module and IO point
      const moduleStatus: NetworkNodeStatus = chainStatus.module.connected
        ? (chainStatus.module.errorCount && chainStatus.module.errorCount > 0 ? "warning" : "connected")
        : "disconnected"

      const moduleLabel = chainStatus.module.name || "Module"
      const moduleBadge = chainStatus.module.deviceType || undefined

      let moduleMessage = chainStatus.module.message || ""
      if (chainStatus.module.ipAddress) {
        moduleMessage += ` (IP: ${chainStatus.module.ipAddress})`
      }
      if (chainStatus.module.totalTags) {
        moduleMessage += ` | ${chainStatus.module.respondingTags ?? 0}/${chainStatus.module.totalTags} tags OK`
      }
      if (chainStatus.module.parentDevice) {
        moduleMessage += ` | Parent: ${chainStatus.module.parentDevice}`
      }

      nodes.push({
        name: "module",
        label: moduleLabel,
        status: moduleStatus,
        badge: moduleBadge,
        statusCode: chainStatus.module.errorCount && chainStatus.module.errorCount > 0
          ? `${chainStatus.module.errorCount} errors`
          : undefined,
        message: moduleMessage,
        icon: <Box className="w-4 h-4" />
      })

      nodes.push({
        name: "io",
        label: chainStatus.ioPoint.name || "I/O Point",
        status: chainStatus.ioPoint.connected ? "connected" : "disconnected",
        statusCode: chainStatus.ioPoint.statusCode,
        message: chainStatus.ioPoint.message || (chainStatus.ioPoint.connected
          ? "Tag reading OK"
          : "Tag read failed"),
        icon: <Radio className="w-4 h-4" />
      })
    } else {
      // Aggregate mode: show module summary
      const totalTags = chainStatus.module.totalTags ?? 0
      const respondingTags = chainStatus.module.respondingTags ?? 0
      const errorCount = chainStatus.module.errorCount ?? 0

      const aggregateStatus: NetworkNodeStatus = !chainStatus.plc.connected
        ? "disconnected"
        : errorCount > 0
          ? "warning"
          : "connected"

      const aggregateLabel = errorCount > 0
        ? `${errorCount} errors`
        : totalTags > 0
          ? `${respondingTags}/${totalTags} OK`
          : "Modules"

      nodes.push({
        name: "modules",
        label: aggregateLabel,
        status: aggregateStatus,
        message: chainStatus.module.message || `${totalTags} total tags across all modules`,
        icon: <Box className="w-4 h-4" />
      })
    }

    return nodes
  }

  const nodes = buildNodes()

  return (
    <div className={cn("relative", className)}>
      <div className="flex items-center gap-1 py-2 px-3 bg-muted/50 rounded-lg overflow-x-auto">
        <span className="text-xs text-muted-foreground mr-2 whitespace-nowrap">Network:</span>
        {nodes.map((node, index) => (
          <div key={node.name} className="flex items-center">
            <div
              className="relative flex items-center gap-1.5 px-2 py-1 rounded hover:bg-muted cursor-help transition-colors"
              onMouseEnter={() => setHoveredNode(node.name)}
              onMouseLeave={() => setHoveredNode(null)}
            >
              {/* Status indicator dot */}
              <div className={cn("w-2 h-2 rounded-full shrink-0", getStatusColor(node.status))} />
              {/* Icon */}
              <span className="text-muted-foreground shrink-0">{node.icon}</span>
              {/* Label */}
              <span className="text-xs font-medium truncate max-w-[100px]">{node.label}</span>
              {/* Device type badge */}
              {node.badge && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-muted-foreground/10 text-muted-foreground font-mono">
                  {node.badge}
                </span>
              )}

              {/* Tooltip */}
              {hoveredNode === node.name && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 min-w-[200px] max-w-[280px]">
                  <div className="bg-popover text-popover-foreground border rounded-md shadow-md p-3">
                    <div className="flex items-center gap-2 mb-1">
                      {getStatusIcon(node.status)}
                      <span className="font-medium text-sm">{node.label}</span>
                    </div>
                    {node.statusCode && (
                      <div className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded inline-block mb-1">
                        {node.statusCode}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">{node.message}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Arrow connector */}
            {index < nodes.length - 1 && (
              <svg className="w-4 h-4 text-muted-foreground/50 mx-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 18l6-6-6-6" />
              </svg>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
