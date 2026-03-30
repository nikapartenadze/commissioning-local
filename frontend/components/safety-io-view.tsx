"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ShieldAlert, Zap, ZapOff, AlertTriangle, Square } from "lucide-react"
import { authFetch } from "@/lib/api-config"
import { cn } from "@/lib/utils"

interface SafetyOutput {
  id: number
  tag: string
  description: string | null
  outputType: string | null
  state?: boolean | null
}

interface SafetyDrive {
  id: number
  name: string
}

interface SafetyZone {
  id: number
  name: string
  stoSignal: string
  bssTag: string
  drives: SafetyDrive[]
}

interface SafetyIoViewProps {
  subsystemId?: number
}

export default function SafetyIoView({ subsystemId }: SafetyIoViewProps) {
  const [outputs, setOutputs] = useState<SafetyOutput[]>([])
  const [zones, setZones] = useState<SafetyZone[]>([])
  const [loadingOutputs, setLoadingOutputs] = useState(true)
  const [loadingZones, setLoadingZones] = useState(true)

  // Fire output state
  const [fireConfirmTag, setFireConfirmTag] = useState<string | null>(null)
  const [firingTag, setFiringTag] = useState<string | null>(null)

  // Bypass state
  const [bypassConfirmZone, setBypassConfirmZone] = useState<SafetyZone | null>(null)
  const [activeBypass, setActiveBypass] = useState<SafetyZone | null>(null)
  const activeBypassRef = useRef<SafetyZone | null>(null)

  // Keep ref in sync for cleanup
  useEffect(() => {
    activeBypassRef.current = activeBypass
  }, [activeBypass])

  // Fetch outputs
  useEffect(() => {
    const params = new URLSearchParams()
    if (subsystemId) params.set("subsystemId", String(subsystemId))
    authFetch(`/api/safety/outputs?${params}`)
      .then(res => res.ok ? res.json() : Promise.reject())
      .then(data => setOutputs(data.outputs || []))
      .catch(() => setOutputs([]))
      .finally(() => setLoadingOutputs(false))
  }, [subsystemId])

  // Fetch zones
  useEffect(() => {
    const params = new URLSearchParams()
    if (subsystemId) params.set("subsystemId", String(subsystemId))
    authFetch(`/api/safety/zones?${params}`)
      .then(res => res.ok ? res.json() : Promise.reject())
      .then(data => setZones(data.zones || []))
      .catch(() => setZones([]))
      .finally(() => setLoadingZones(false))
  }, [subsystemId])

  // Cleanup: stop bypass on unmount
  useEffect(() => {
    return () => {
      if (activeBypassRef.current) {
        authFetch("/api/safety/bypass", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bssTag: activeBypassRef.current.bssTag, action: "stop" }),
        }).catch(() => {})
      }
    }
  }, [])

  const handleFire = async (tag: string) => {
    setFiringTag(tag)
    try {
      await authFetch("/api/safety/fire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag, action: "toggle" }),
      })
    } catch {
      // ignore
    } finally {
      setFiringTag(null)
      setFireConfirmTag(null)
    }
  }

  const handleStartBypass = async (zone: SafetyZone) => {
    try {
      await authFetch("/api/safety/bypass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bssTag: zone.bssTag, action: "start" }),
      })
      setBypassConfirmZone(null)
      setActiveBypass(zone)
    } catch {
      // ignore
    }
  }

  const handleStopBypass = useCallback(async () => {
    if (!activeBypassRef.current) return
    try {
      await authFetch("/api/safety/bypass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bssTag: activeBypassRef.current.bssTag, action: "stop" }),
      })
    } catch {
      // ignore
    } finally {
      setActiveBypass(null)
    }
  }, [])

  return (
    <div className="space-y-6 py-4">
      {/* Section A: Safety Outputs */}
      {/* STO Bypass Zones */}
      <div>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" />
          STO Bypass Zones
        </h2>
        {loadingZones ? (
          <p className="text-muted-foreground text-sm">Loading zones...</p>
        ) : zones.length === 0 ? (
          <p className="text-muted-foreground text-sm">No STO bypass zones configured</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {zones.map(zone => (
              <Card key={zone.id} className="flex flex-col">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{zone.name}</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 space-y-3">
                  <p className="text-xs text-muted-foreground font-mono">STO: {zone.stoSignal}</p>
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                    <p className="text-sm font-bold text-white mb-2">⚠ Following drives will STOP running:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {zone.drives.map(d => (
                        <Badge key={d.id} className="text-xs bg-red-950 text-white border border-red-500/40 font-mono">{d.name}</Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
                <div className="px-6 pb-4">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => setBypassConfirmZone(zone)}
                  >
                    <AlertTriangle className="h-3 w-3 mr-1" />
                    Bypass
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Fire Confirmation Dialog */}
      <Dialog open={!!fireConfirmTag} onOpenChange={(open) => { if (!open) setFireConfirmTag(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Confirm Fire Output
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            Safety outputs can cause motion to occur. Verify device is safe to actuate, if applicable.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFireConfirmTag(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => fireConfirmTag && handleFire(fireConfirmTag)}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bypass Confirmation Dialog */}
      <Dialog open={!!bypassConfirmZone} onOpenChange={(open) => { if (!open) setBypassConfirmZone(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              WARNING
            </DialogTitle>
          </DialogHeader>
          {bypassConfirmZone && (
            <p className="text-sm">
              Bypassing safety in <strong>{bypassConfirmZone.name}</strong> will STOP{" "}
              <strong>{bypassConfirmZone.drives.length}</strong> drives:{" "}
              {bypassConfirmZone.drives.map(d => d.name).join(", ")}.
              Do you want to proceed?
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBypassConfirmZone(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => bypassConfirmZone && handleStartBypass(bypassConfirmZone)}>
              Proceed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Active Bypass Full-Screen Overlay */}
      {activeBypass && (
        <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center" style={{ top: 0, left: 0, right: 0, bottom: 0, margin: 0, padding: 0 }}>
          <div className="absolute inset-0 border-8 border-red-500 animate-pulse pointer-events-none" />
          <div className="flex flex-col items-center justify-center gap-6 relative z-10">
            <AlertTriangle className="h-20 w-20 text-red-500" />
            <h1 className="text-4xl font-bold text-red-500">SAFETY BYPASSED</h1>
            <div className="text-center space-y-3 max-w-md">
              <p className="text-2xl font-bold text-foreground">{activeBypass.name}</p>
              <p className="text-xl font-mono font-semibold text-foreground">{activeBypass.stoSignal}</p>
              <div className="mt-4">
                <p className="text-sm font-medium text-foreground mb-2">Stopped Drives:</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {activeBypass.drives.map(d => (
                    <Badge key={d.id} variant="destructive">{d.name}</Badge>
                  ))}
                </div>
              </div>
            </div>
            <Button
              size="lg"
              variant="destructive"
              className="mt-8 text-xl px-12 py-6 h-auto"
              onClick={handleStopBypass}
            >
              <Square className="h-6 w-6 mr-2" />
              STOP BYPASS
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
