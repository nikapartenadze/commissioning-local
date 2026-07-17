"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ShieldAlert, Zap, ZapOff, AlertTriangle, Square } from "lucide-react"
import { authFetch } from "@/lib/api-config"
import { cn } from "@/lib/utils"
import { safetySectionStatus } from "@/lib/safety-section-status"

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
  // A failed zones fetch must NOT look like "none configured" (safety honesty).
  const [zonesError, setZonesError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // Tag values from PLC
  const [tagValues, setTagValues] = useState<Record<string, boolean | null>>({})

  // Fire output state
  const [fireConfirmTag, setFireConfirmTag] = useState<string | null>(null)
  const [firingTag, setFiringTag] = useState<string | null>(null)

  // Bypass state
  const [bypassConfirmZone, setBypassConfirmZone] = useState<SafetyZone | null>(null)
  const [activeBypass, setActiveBypass] = useState<SafetyZone | null>(null)
  const activeBypassRef = useRef<SafetyZone | null>(null)
  // Set when the server tore the keep-alive down under us (PLC disconnect /
  // repeated write failure) so the overlay closes and the operator is warned.
  const [bypassLostNotice, setBypassLostNotice] = useState(false)

  // Keep ref in sync for cleanup
  useEffect(() => {
    activeBypassRef.current = activeBypass
  }, [activeBypass])

  // Reflect a server-side keep-alive teardown. The server drops the bypass from
  // its active map (and broadcasts BypassEnded) when the PLC disconnects or the
  // hold-bit write keeps failing — but this view has no WS subscription, so poll
  // the active-bypass list while the overlay is up and close it if our tag is
  // gone. Without this the operator keeps seeing "BYPASS ACTIVE" while the STO
  // bit is no longer actually held.
  useEffect(() => {
    if (!activeBypass) return
    let active = true
    const check = async () => {
      try {
        const res = await authFetch('/api/safety/bypass')
        if (!res.ok || !active) return
        const data = await res.json()
        const tag = activeBypassRef.current?.bssTag
        const stillHeld = Array.isArray(data.active) && tag != null && data.active.includes(tag)
        if (!stillHeld && active) {
          setActiveBypass(null)
          setBypassLostNotice(true)
        }
      } catch { /* transient — try again next tick */ }
    }
    const interval = setInterval(check, 2000)
    return () => { active = false; clearInterval(interval) }
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
    setLoadingZones(true)
    authFetch(`/api/safety/zones?${params}`)
      .then(res => res.ok ? res.json() : Promise.reject())
      .then(data => { setZones(data.zones || []); setZonesError(false) })
      .catch(() => { setZones([]); setZonesError(true) })
      .finally(() => setLoadingZones(false))
  }, [subsystemId, reloadKey])

  // Poll tag values every 3 seconds
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const res = await authFetch('/api/safety/status')
        if (res.ok && active) {
          const data = await res.json()
          if (data.success && data.tags) setTagValues(data.tags)
        }
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  // Cleanup: stop bypass on unmount
  useEffect(() => {
    return () => {
      if (activeBypassRef.current) {
        authFetch("/api/safety/bypass", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bssTag: activeBypassRef.current.bssTag, action: "stop", subsystemId }),
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
        body: JSON.stringify({ tag, action: "toggle", subsystemId }),
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
        body: JSON.stringify({ bssTag: zone.bssTag, action: "start", subsystemId }),
      })
      setBypassConfirmZone(null)
      setBypassLostNotice(false)
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
        // subsystemId is REQUIRED: the server keys the 500ms bypass keep-alive by
        // `${subsystemId}:${bssTag}` and resolves the release write to that MCM's
        // controller. Omitting it (the old bug) meant STOP BYPASS never cleared
        // the keep-alive (STO bypass bit stayed asserted TRUE) and wrote the
        // release to the legacy singleton, not this MCM — a safety misroute on a
        // multi-MCM box. Must match handleStartBypass / the unmount cleanup.
        body: JSON.stringify({ bssTag: activeBypassRef.current.bssTag, action: "stop", subsystemId }),
      })
    } catch {
      // ignore
    } finally {
      setActiveBypass(null)
    }
  }, [subsystemId])

  return (
    <div className="space-y-6 py-4">
      {/* Bypass-ended warning: the server tore the keep-alive down (PLC
          disconnect / repeated write failure) while the overlay was up. */}
      {bypassLostNotice && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            Bypass ended unexpectedly — the STO bypass bit is no longer being held
            (PLC connection lost or the hold-bit write kept failing). Re-check the
            zone before relying on it.
          </div>
          <Button variant="ghost" size="sm" onClick={() => setBypassLostNotice(false)}>
            Dismiss
          </Button>
        </div>
      )}
      {/* Section A: Safety Outputs */}
      {/* STO Bypass Zones */}
      <div>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" />
          STO Bypass Zones
        </h2>
        {loadingZones ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1,2,3].map(i => (
              <div key={i} className="h-48 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : safetySectionStatus(loadingZones, zonesError, zones.length) === 'error' ? (
          <div role="alert" className="flex items-center gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">Failed to load STO bypass zones — this is NOT a confirmation that none exist. Retry before relying on it.</span>
            <Button variant="outline" size="sm" onClick={() => setReloadKey(k => k + 1)}>Retry</Button>
          </div>
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
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">STO Signal</span>
                      <span className="text-xs font-mono font-semibold text-foreground">{zone.stoSignal}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">BSS Tag</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground">{zone.bssTag}</span>
                        <span className={cn("text-xs font-bold font-mono",
                          tagValues[zone.bssTag] === true ? "text-red-500" :
                          tagValues[zone.bssTag] === false ? "text-green-500" :
                          "text-muted-foreground"
                        )}>
                          {tagValues[zone.bssTag] === true ? "TRUE" : tagValues[zone.bssTag] === false ? "FALSE" : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                    <p className="text-sm font-bold text-red-700 dark:text-red-300 mb-2">⚠ Following drives will STOP running:</p>
                    <div className="space-y-1">
                      {zone.drives.map(d => (
                        <div key={d.id} className="flex items-center justify-between">
                          <span className="text-xs font-mono text-red-700 dark:text-red-300">{d.name}</span>
                          <span className={cn("text-xs font-bold font-mono",
                            tagValues[`${d.name}:SI.STOActive`] === true ? "text-green-400" :
                            tagValues[`${d.name}:SI.STOActive`] === false ? "text-red-400" :
                            "text-muted-foreground"
                          )}>
                            {tagValues[`${d.name}:SI.STOActive`] === true ? "TRUE" :
                             tagValues[`${d.name}:SI.STOActive`] === false ? "FALSE" : "—"}
                          </span>
                        </div>
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
