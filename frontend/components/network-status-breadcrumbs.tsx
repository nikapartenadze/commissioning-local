"use client"

import { useState, useEffect } from "react"
import { CheckCircle, XCircle, AlertCircle, Circle, Loader2, Cloud, Server, Cpu, Box, Radio } from "lucide-react"
import { cn } from "@/lib/utils"

type NetworkNodeStatus = "connected" | "disconnected" | "warning" | "unknown" | "loading"

interface NetworkNode {
  name: string
  label: string
  status: NetworkNodeStatus
  statusCode?: string
  message?: string
  icon: React.ReactNode
}

interface NetworkChainStatus {
  cloud: { connected: boolean; message?: string }
  backend: { connected: boolean; message?: string }
  plc: { connected: boolean; ip?: string; path?: string; message?: string }
  module: { name: string; connected: boolean; errorCount?: number; message?: string }
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

  useEffect(() => {
    fetchNetworkStatus()
    // Refresh every 5 seconds for live updates
    const interval = setInterval(fetchNetworkStatus, 5000)
    return () => clearInterval(interval)
  }, [tagName])

  const fetchNetworkStatus = async () => {
    try {
      const url = tagName
        ? `http://localhost:5000/api/network/chain-status?tagName=${encodeURIComponent(tagName)}`
        : `http://localhost:5000/api/network/chain-status`

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

  const buildNodes = (): NetworkNode[] => {
    if (!chainStatus) {
      return [
        { name: "cloud", label: "Cloud", status: "loading", icon: <Cloud className="w-4 h-4" /> },
        { name: "backend", label: "Backend", status: "loading", icon: <Server className="w-4 h-4" /> },
        { name: "plc", label: "PLC", status: "loading", icon: <Cpu className="w-4 h-4" /> },
        { name: "module", label: "Module", status: "loading", icon: <Box className="w-4 h-4" /> },
        { name: "io", label: "I/O", status: "loading", icon: <Radio className="w-4 h-4" /> },
      ]
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
      {
        name: "module",
        label: chainStatus.module.name || "Module",
        status: chainStatus.module.connected
          ? (chainStatus.module.errorCount && chainStatus.module.errorCount > 0 ? "warning" : "connected")
          : "disconnected",
        statusCode: chainStatus.module.errorCount && chainStatus.module.errorCount > 0
          ? `${chainStatus.module.errorCount} errors`
          : undefined,
        message: chainStatus.module.message || (chainStatus.module.connected
          ? (chainStatus.module.errorCount ? `${chainStatus.module.errorCount} tag errors in module` : "Module responding")
          : "Module not responding"),
        icon: <Box className="w-4 h-4" />
      },
      {
        name: "io",
        label: chainStatus.ioPoint.name || "I/O Point",
        status: chainStatus.ioPoint.connected ? "connected" : "disconnected",
        statusCode: chainStatus.ioPoint.statusCode,
        message: chainStatus.ioPoint.message || (chainStatus.ioPoint.connected
          ? "Tag reading OK"
          : "Tag read failed"),
        icon: <Radio className="w-4 h-4" />
      }
    ]

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
              <span className="text-xs font-medium truncate max-w-[80px]">{node.label}</span>

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
