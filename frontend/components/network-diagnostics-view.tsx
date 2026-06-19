"use client"

/**
 * Full-page live network diagnostics dashboard.
 *
 * Subscribes to the parent's liveSnapshots cache (see useNetworkSnapshots())
 * and renders the IOCT_COMMUNICATION_MONITOR layout natively in the
 * Autstand industrial aesthetic — IBM Plex Sans + JetBrains Mono, gold/amber
 * primary, theme-aware via the app's HSL tokens. No inlined CSS; all styling
 * uses Tailwind utilities that respect light/dark mode.
 *
 *   - TOC grouped by device type with status-color left-bezels.
 *   - One section per device: instrument-style header (mono device name +
 *     OK/WARN/STALE chip), facts row (Product Code / Firmware / Active Ports
 *     / Last Snapshot), and a 3-column grid of port cards.
 *   - Each port card has three panels (Link / Interface Counters / Media
 *     Counters) laid out in a row when there's screen width. Zero rows are
 *     muted; non-zero errors are red, non-zero discards amber; the Media
 *     panel switches to an amber-bezel when any of its counters > 0.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Network, ServerCrash, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NetworkDeviceSnapshotMessage, RingStatusUpdateMessage } from '@/lib/plc/types'
import { RingHealthBadge } from '@/components/ring-health-badge'
import { isExcludedRackSlot } from '@/lib/plc/network/types'
import { authFetch } from '@/lib/api-config'

type Snapshot = NetworkDeviceSnapshotMessage['snapshot']
type Port = Snapshot['ports'][number]

interface Props {
  /** Reserved — kept for prop stability; data comes from `liveSnapshots`. */
  active: boolean
  /**
   * When set, the view shows ONLY this device's section (live or skeleton),
   * with no TOC and no group headers.
   */
  singleDevice?: string
  /**
   * Optional list of device names the topology already knows about (the ring
   * nodes). These render as skeleton sections when no live snapshot exists.
   */
  knownDevices?: string[]
  /** Live snapshots cache maintained by useNetworkSnapshots() at the parent. */
  liveSnapshots?: Map<string, Snapshot>
  /** WS connection status from the parent. */
  wsConnected?: boolean
  /** Latest DLR ring verdict from the poller (null until the first push). */
  ringStatus?: RingStatusUpdateMessage['ring'] | null
  /**
   * Selected MCM on a CENTRAL server. Threaded into the firmware
   * baseline/controller fetches as `?subsystemId=` so a multi-MCM tool scopes
   * compliance to the chosen subsystem instead of whichever MCM was last
   * resolved. Omitted on a single-MCM tablet → endpoints return the sole MCM.
   */
  subsystemId?: number
}

const STALE_MS = 60_000

// ─── Helpers ────────────────────────────────────────────────────────────

function deviceTypeOf(name: string): string {
  if (name.includes('VFD')) return 'VFD'
  if (name.includes('FIOM')) return 'FIOM'
  if (name.includes('FIOH')) return 'FIOH'
  if (name.includes('PMM')) return 'PMM'
  if (name.includes('SIO')) return 'SIO'
  if (name.includes('VSU')) return 'VSU'
  if (/(^|_)VR(_|$)/.test(name)) return 'VR'
  if (/(^|_)EX(_|$)/.test(name)) return 'EX'
  if (name.includes('LPE')) return 'LPE'
  if (name.includes('POINT') || name.includes('IB16') || name.includes('OB16')) return 'I/O'
  if (name.includes('DPM') || name.includes('EN4TR') || name.includes('EN2TR') || name.includes('SLOT')) return 'DPM'
  return 'Other'
}

// Port-visibility policy (field request, 2026-05-26):
//   - The Octopus switch (the DPM/managed switch in each ring) carries real
//     traffic across all of its ports → show every port (1–32).
//   - Every other device (VFD, FIOM, PMM, …) only uses the two ring uplink
//     ports → show ports 1–2 only. The rest of the 33-slot UDT array is
//     unused noise on those devices.
// A device is the Octopus switch iff it classifies as the DPM group above.
const OCTOPUS_PORT_CAP = 32
const DEFAULT_PORT_CAP = 2

function isOctopusSwitch(deviceName: string): boolean {
  return deviceTypeOf(deviceName) === 'DPM'
}

/** Highest physical port number we surface for this device. */
function portCapFor(deviceName: string): number {
  return isOctopusSwitch(deviceName) ? OCTOPUS_PORT_CAP : DEFAULT_PORT_CAP
}

/**
 * Ports we actually display + summarize for a device. Everything downstream
 * (summary counts, status badges, error chips, port rows) keys off this so the
 * status can never reference a port the operator can't see.
 */
function visiblePorts(snap: Snapshot): Port[] {
  const cap = portCapFor(snap.deviceName)
  return snap.ports.filter((p) => p.portNumber >= 1 && p.portNumber <= cap)
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function hasMediaErrors(p: Port): boolean {
  return (
    p.alignErr > 0 || p.fcsErr > 0 || p.singleColl > 0 || p.multiColl > 0 ||
    p.sqeErr > 0 || p.deferredTx > 0 || p.lateColl > 0 || p.excessColl > 0 ||
    p.macTxErr > 0 || p.carrierSense > 0 || p.frameTooLong > 0 || p.macRxErr > 0
  )
}
function hasInterfaceErrors(p: Port): boolean {
  return p.errorsIn > 0 || p.errorsOut > 0 || p.discardsIn > 0 || p.discardsOut > 0
}
function isActivelyDown(p: Port): boolean {
  if (p.linkUp) return false
  return p.octetsIn > 0 || p.octetsOut > 0
}

interface DeviceSummary {
  activePorts: number
  /** Total problem ports (errorPorts + warnPorts). */
  warnCount: number
  /** Ports with physical-layer problems: actively down, media errors, interface errors, or hardware fault. RED severity. */
  errorCount: number
  /** Ports with only soft signals (discards): RED is too loud, ORANGE is right. */
  softWarnCount: number
  errorPorts: Port[]
  mediaPorts: Port[]
  downPorts: Port[]
}

function hasHardError(p: Port): boolean {
  // Physical-layer / frame-level problems. These are real network breakage,
  // not "things are a bit slow" — should always render RED.
  return p.hardwareFault || hasMediaErrors(p) || p.errorsIn > 0 || p.errorsOut > 0
}
function hasOnlyDiscards(p: Port): boolean {
  // Discards without any hard errors → soft warning. The PLC chose to drop
  // these packets (e.g. congestion); nothing is broken at the wire level.
  return (p.discardsIn > 0 || p.discardsOut > 0) && !hasHardError(p)
}

function summarize(snap: Snapshot): DeviceSummary {
  let activePorts = 0, errorCount = 0, softWarnCount = 0
  const errorPorts: Port[] = []
  const mediaPorts: Port[] = []
  const downPorts: Port[] = []
  // Only the visible ports count toward the device's health roll-up.
  for (const p of visiblePorts(snap)) {
    if (p.linkUp) activePorts++
    const down = isActivelyDown(p)
    if (down) downPorts.push(p)
    if (hasMediaErrors(p)) mediaPorts.push(p)
    if (down || hasHardError(p)) {
      errorCount++
      errorPorts.push(p)
    } else if (hasOnlyDiscards(p)) {
      softWarnCount++
    }
  }
  return {
    activePorts,
    warnCount: errorCount + softWarnCount,
    errorCount,
    softWarnCount,
    errorPorts,
    mediaPorts,
    downPorts,
  }
}

type TocStatus = 'ok' | 'error' | 'warn' | 'pending'
function tocStatusOf(snap: Snapshot | null, lastSeen: number, now: number, summary: DeviceSummary | null): TocStatus {
  if (!snap) return 'pending'
  if (now - lastSeen > STALE_MS) return 'warn' // stale data — orange, not red, because it might be transient
  if (!summary) return 'ok'
  if (summary.errorCount > 0) return 'error'
  if (summary.softWarnCount > 0) return 'warn'
  return 'ok'
}

interface DeviceState {
  snapshot: Snapshot
  lastSeen: number
}

// ─── Main view ───────────────────────────────────────────────────────────

export function NetworkDiagnosticsView({
  active,
  singleDevice,
  knownDevices = [],
  liveSnapshots,
  wsConnected = false,
  ringStatus = null,
  subsystemId,
}: Props) {
  const [now, setNow] = useState(() => Date.now())

  // Scope firmware compliance lookups to THIS MCM on a central server. Omitted
  // on a single-MCM tablet (no subsystemId) → endpoints return the sole MCM.
  const scope = subsystemId ? `?subsystemId=${subsystemId}` : ''

  useEffect(() => {
    if (!active) return
    // 5s, not 1s — `now` only drives staleness + "X ago" labels against a ~60s
    // data cadence, so the extra ticks just churned the header/TOC re-renders.
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [active])

  // Approved-firmware baseline for the per-device compliance chip. Optional —
  // if it can't be fetched, devices simply render without a firmware verdict.
  const [baselines, setBaselines] = useState<FwBaseline[]>([])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    authFetch(`/api/firmware/baseline${scope}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && Array.isArray(d?.baselines)) setBaselines(d.baselines) })
      .catch(() => { /* baseline optional */ })
    return () => { cancelled = true }
  }, [active, scope])

  // Controller firmware (not a network node → not in liveSnapshots). One @raw
  // read on open; optional — the card hides if it can't be read.
  const [controllerFw, setControllerFw] = useState<ControllerFw | null>(null)
  useEffect(() => {
    if (!active || singleDevice) return
    let cancelled = false
    authFetch(`/api/firmware/controller${scope}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setControllerFw(d?.controller ?? null) })
      .catch(() => { /* controller card optional */ })
    return () => { cancelled = true }
  }, [active, singleDevice, scope])

  const lastSeenRef = useRef<Map<string, DeviceState>>(new Map())
  const devices = useMemo<Map<string, DeviceState>>(() => {
    const out = new Map<string, DeviceState>()
    if (!liveSnapshots) return out
    const now2 = Date.now()
    for (const [deviceName, snap] of Array.from(liveSnapshots.entries())) {
      // Excluded rack slots (SLOT5/6/7) are dropped at the poller, but guard
      // here too so a stale cached snapshot can never resurface them.
      if (isExcludedRackSlot(deviceName)) continue
      const prev = lastSeenRef.current.get(deviceName)
      const lastSeen = prev && prev.snapshot === snap ? prev.lastSeen : now2
      out.set(deviceName, { snapshot: snap, lastSeen })
    }
    lastSeenRef.current = out
    return out
  }, [liveSnapshots])

  // Known devices come from the topology (rings), which can still list
  // excluded rack slots — filter them so they don't render as empty skeletons.
  const visibleKnownDevices = useMemo(
    () => knownDevices.filter((n) => n && !isExcludedRackSlot(n)),
    [knownDevices],
  )

  const groups = useMemo(() => {
    const union = new Map<string, { deviceName: string; live?: DeviceState }>()
    for (const name of visibleKnownDevices) {
      if (!name) continue
      union.set(name, { deviceName: name })
    }
    for (const ds of Array.from(devices.values())) {
      union.set(ds.snapshot.deviceName, { deviceName: ds.snapshot.deviceName, live: ds })
    }

    if (singleDevice) {
      const target = union.get(singleDevice) ?? { deviceName: singleDevice }
      return [[deviceTypeOf(target.deviceName), [target]]] as [
        string,
        { deviceName: string; live?: DeviceState }[],
      ][]
    }

    const map = new Map<string, { deviceName: string; live?: DeviceState }[]>()
    for (const entry of Array.from(union.values())) {
      const g = deviceTypeOf(entry.deviceName)
      const list = map.get(g) ?? []
      list.push(entry)
      map.set(g, list)
    }
    for (const list of Array.from(map.values())) {
      list.sort((a, b) => a.deviceName.localeCompare(b.deviceName))
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [devices, visibleKnownDevices, singleDevice])

  const totalDevices = devices.size
  const totalKnown = useMemo(() => {
    const set = new Set<string>()
    for (const n of visibleKnownDevices) if (n) set.add(n)
    for (const ds of Array.from(devices.values())) set.add(ds.snapshot.deviceName)
    return set.size
  }, [devices, visibleKnownDevices])
  const totalGroups = groups.length

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {/* Header ── instrument-panel style. pr-12 keeps content clear of the
          Dialog's auto-rendered close (×) button at top-right. */}
      <header className="flex-shrink-0 border-b bg-card px-5 py-3.5 pr-12">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative shrink-0">
            <Network className="w-5 h-5 text-primary" />
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-card',
                wsConnected ? 'bg-emerald-500 status-pulse' : 'bg-orange-500',
              )}
              aria-label={wsConnected ? 'live' : 'reconnecting'}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold tracking-tight truncate">
              {singleDevice ? (
                <>
                  <span className="text-muted-foreground/70 font-normal">Diagnostics — </span>
                  <span className="font-mono">{singleDevice}</span>
                </>
              ) : (
                'Network Diagnostics'
              )}
            </h1>
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mt-0.5 font-medium flex items-center gap-1.5 flex-wrap">
              {singleDevice ? (
                <>
                  <span>{groups[0]?.[0] ?? 'Other'}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{wsConnected ? 'live' : 'reconnecting…'}</span>
                </>
              ) : (
                <>
                  <span>{totalKnown} device{totalKnown === 1 ? '' : 's'}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-primary">{totalDevices} live</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{totalGroups} group{totalGroups === 1 ? '' : 's'}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{wsConnected ? 'live' : 'reconnecting…'}</span>
                </>
              )}
            </p>
          </div>
          <RingHealthBadge ring={ringStatus} />
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="px-5 py-4">
          {!singleDevice && <ControllerFirmwareCard controller={controllerFw} />}
          {!singleDevice && totalKnown === 0 && (
            <div className="border border-dashed border-border bg-card/50 px-5 py-10 text-center text-sm text-muted-foreground rounded">
              {active
                ? 'No network devices in topology yet. Pull the latest from cloud or connect to a PLC with *_NN tags.'
                : 'Diagnostics view inactive.'}
            </div>
          )}

          {totalKnown > 0 && (
            <>
              {!singleDevice && <NavToc groups={groups} now={now} />}

              {groups.map(([groupName, deviceList]) => (
                <div className="mb-6 last:mb-0" key={groupName} id={`grp-${groupName}`}>
                  {!singleDevice && (
                    <h2 className="flex items-center gap-3 text-xs uppercase tracking-[0.22em] font-semibold text-muted-foreground mb-2.5 border-b pb-1.5">
                      <span className="text-foreground">{groupName}</span>
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30 normal-case tracking-normal">
                        {deviceList.length}
                      </span>
                      <span className="flex-1 h-px bg-gradient-to-r from-border to-transparent" />
                    </h2>
                  )}
                  <div className="space-y-3">
                    {deviceList.map((entry) =>
                      entry.live ? (
                        <DeviceSection key={entry.deviceName} state={entry.live} now={now} defaultExpanded={!!singleDevice} baselines={baselines} />
                      ) : (
                        <SkeletonSection key={entry.deviceName} deviceName={entry.deviceName} active={active} />
                      ),
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── TOC ─────────────────────────────────────────────────────────────────

function NavToc({
  groups,
  now,
}: {
  groups: [string, { deviceName: string; live?: DeviceState }[]][]
  now: number
}) {
  return (
    <nav className="mb-6 border bg-card rounded-md overflow-hidden">
      <div className="px-4 py-2 border-b bg-muted/40 flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-foreground">Quick Jump</span>
      </div>
      <div className="p-3 grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
        {groups.map(([groupName, list]) => (
          <div key={groupName} className="border bg-background/60 rounded">
            <a
              href={`#grp-${groupName}`}
              className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 hover:bg-muted/60 transition-colors group"
            >
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground group-hover:text-primary transition-colors">
                {groupName}
              </span>
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
                {list.length}
              </span>
            </a>
            <div className="grid grid-cols-1 divide-y divide-border">
              {list.map((entry) => {
                const summary = entry.live ? summarize(entry.live.snapshot) : null
                const status = tocStatusOf(entry.live?.snapshot ?? null, entry.live?.lastSeen ?? 0, now, summary)
                const dotClass =
                  status === 'ok' ? 'bg-emerald-500 status-pulse' :
                  status === 'error' ? 'bg-red-500' :
                  status === 'warn' ? 'bg-orange-500' :
                  'bg-muted-foreground/40'
                const borderClass =
                  status === 'ok' ? 'border-l-emerald-500/60' :
                  status === 'error' ? 'border-l-red-500/60 bg-red-500/[0.03]' :
                  status === 'warn' ? 'border-l-orange-500/60 bg-orange-500/[0.03]' :
                  'border-l-muted-foreground/20'
                const portCap = portCapFor(entry.deviceName)
                const trailing = entry.live && summary
                  ? summary.errorCount > 0
                    ? `${summary.activePorts}/${portCap} · ${summary.errorCount} err`
                    : summary.softWarnCount > 0
                      ? `${summary.activePorts}/${portCap} · ${summary.softWarnCount} warn`
                      : `${summary.activePorts}/${portCap} · ok`
                  : 'awaiting'
                return (
                  <a
                    href={`#${entry.deviceName}_NN`}
                    key={entry.deviceName}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-1.5 border-l-2 hover:bg-accent/40 transition-colors',
                      borderClass,
                    )}
                  >
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotClass)} aria-hidden />
                    <span className="font-mono text-[11px] font-semibold truncate min-w-0 flex-1">
                      {entry.deviceName}
                    </span>
                    <span
                      className={cn(
                        'text-[9px] uppercase tracking-wider font-medium shrink-0',
                        status === 'error' ? 'text-red-500'
                          : status === 'warn' ? 'text-orange-500'
                          : 'text-muted-foreground',
                      )}
                    >
                      {trailing}
                    </span>
                  </a>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </nav>
  )
}

// ─── Device section ──────────────────────────────────────────────────────

/** Cached approved-firmware baseline entry (from GET /api/firmware/baseline). */
export interface FwBaseline {
  vendorId: number
  productCode: number
  modelName?: string
  minRevMajor: number
  minRevMinor: number
}

type FwVerdict = 'compliant' | 'non_compliant' | 'no_baseline' | 'unknown'

/**
 * Per-device firmware compliance from the snapshot's productCode + firmware vs
 * the baseline (min-version rule). vendorId isn't in the diagnostics UDT, so we
 * match by productCode. A 0/0/0 header means the ladder hasn't populated the
 * Identity MSG yet → unknown (not a real 0.0 rev).
 */
function firmwareVerdict(
  baselines: FwBaseline[], productCode: number, fwMajor: number, fwMinor: number,
): FwVerdict {
  if (productCode === 0 && fwMajor === 0 && fwMinor === 0) return 'unknown'
  const b = baselines.find((x) => x.productCode === productCode)
  if (!b) return 'no_baseline'
  if (fwMajor !== b.minRevMajor) return fwMajor > b.minRevMajor ? 'compliant' : 'non_compliant'
  return fwMinor >= b.minRevMinor ? 'compliant' : 'non_compliant'
}

function FirmwareComplianceChip({ verdict, min }: { verdict: FwVerdict; min?: string }) {
  if (verdict === 'unknown') return null
  const meta: Record<Exclude<FwVerdict, 'unknown'>, { text: string; cls: string }> = {
    compliant: { text: 'FW OK', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    non_compliant: { text: `FW < ${min ?? 'min'}`, cls: 'bg-red-500/15 text-red-600 dark:text-red-400' },
    no_baseline: { text: 'FW no baseline', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  }
  const m = meta[verdict]
  return (
    <span className={cn('font-mono text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5', m.cls)}>
      {m.text}
    </span>
  )
}

/** Controller firmware result from GET /api/firmware/controller. */
export interface ControllerFw {
  label: string
  modelName: string | null
  liveRevision: string | null
  approvedMin: string | null
  serial: number | null
  verdict: 'compliant' | 'non_compliant' | 'no_baseline' | 'unreachable'
}

/** Compact controller-firmware card shown at the top of the full diagnostics view. */
function ControllerFirmwareCard({ controller }: { controller: ControllerFw | null }) {
  if (!controller) return null
  const meta: Record<ControllerFw['verdict'], { text: string; cls: string }> = {
    compliant: { text: 'Compliant', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    non_compliant: { text: `Below min ${controller.approvedMin ?? ''}`.trim(), cls: 'bg-red-500/15 text-red-600 dark:text-red-400' },
    no_baseline: { text: 'No baseline', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    unreachable: { text: 'Unreachable', cls: 'bg-muted text-muted-foreground' },
  }
  const m = meta[controller.verdict]
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border bg-card px-5 py-3">
      <span className="font-mono text-sm font-bold tracking-tight">Controller</span>
      {controller.modelName && <span className="text-sm text-muted-foreground">{controller.modelName}</span>}
      <span className="font-mono text-sm">FW {controller.liveRevision ?? '—'}</span>
      {controller.approvedMin && (
        <span className="text-[11px] text-muted-foreground">min {controller.approvedMin}</span>
      )}
      <span className={cn('ml-auto font-mono text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5', m.cls)}>
        {m.text}
      </span>
    </div>
  )
}

function DeviceSection({ state, now, defaultExpanded, baselines = [] }: { state: DeviceState; now: number; defaultExpanded?: boolean; baselines?: FwBaseline[] }) {
  const { snapshot, lastSeen } = state
  // Collapsed by default in the all-devices view. Even with memoized port rows
  // and the 2-port cap on non-switch devices, rendering every DPM's 32 ports at
  // once on open is a lot of DOM and froze the modal. Header still shows status
  // + error chips; ports render on expand. Single-device view expands on open.
  const [expanded, setExpanded] = useState(!!defaultExpanded)
  const summary = useMemo(() => summarize(snapshot), [snapshot])
  const ports = useMemo(() => visiblePorts(snapshot), [snapshot])
  const portCap = portCapFor(snapshot.deviceName)
  const isStale = now - lastSeen > STALE_MS
  const tagStatus: 'ok' | 'error' | 'warn' | 'stale' = isStale
    ? 'stale'
    : summary.errorCount > 0
      ? 'error'
      : summary.softWarnCount > 0
        ? 'warn'
        : 'ok'

  // Chips surface the actual problem ports. Media errors and actively-down
  // ports are physical-layer faults — RED. Discards-only would be orange but
  // we don't list those individually (the device-level WARN tag is enough).
  const chips: { text: string; kind: 'error'; title: string }[] = [
    ...summary.mediaPorts.map((p) => ({
      text: `P${p.portNumber} media err`,
      kind: 'error' as const,
      title: `AlignErr=${p.alignErr}, FCSErr=${p.fcsErr}, MACRxErr=${p.macRxErr}`,
    })),
    ...summary.downPorts.map((p) => ({
      text: `P${p.portNumber} down`,
      kind: 'error' as const,
      title: `OctetsIn=${p.octetsIn}, OctetsOut=${p.octetsOut}`,
    })),
  ]

  const ageSec = Math.max(0, Math.floor((now - snapshot.capturedAt) / 1000))

  const fwVerdict = firmwareVerdict(baselines, snapshot.productCode, snapshot.firmwareMajor, snapshot.firmwareMinor)
  const fwBaseline = baselines.find((b) => b.productCode === snapshot.productCode)
  const fwMin = fwBaseline ? `${fwBaseline.minRevMajor}.${fwBaseline.minRevMinor}` : undefined

  return (
    <section
      id={`${snapshot.deviceName}_NN`}
      className="border bg-card rounded-md overflow-hidden scroll-mt-4 target:ring-2 target:ring-primary"
    >
      <header
        className="px-5 py-3 border-b bg-muted/30 cursor-pointer select-none hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              {expanded
                ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
              <h2 className="font-mono text-base font-bold tracking-tight">{snapshot.deviceName}</h2>
              <TagBadge status={tagStatus} count={summary.warnCount} />
              <FirmwareComplianceChip verdict={fwVerdict} min={fwMin} />
              {summary.activePorts > 0 && (
                <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                  {summary.activePorts}/{portCap} linked
                </span>
              )}
              {!expanded && (
                <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  · {ports.length} port{ports.length === 1 ? '' : 's'} — click to expand
                </span>
              )}
            </div>
            {chips.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {chips.map((c) => (
                  <Chip key={c.text} kind={c.kind} title={c.title}>
                    {c.text}
                  </Chip>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-1.5 shrink-0">
            <FactCell label="Product Code" value={snapshot.productCode || '—'} />
            <FactCell
              label="Firmware"
              value={
                snapshot.firmwareMajor || snapshot.firmwareMinor
                  ? `${snapshot.firmwareMajor}.${snapshot.firmwareMinor}`
                  : '—'
              }
            />
            <FactCell label="Active Ports" value={summary.activePorts} />
            <FactCell label="Last Snapshot" value={`${ageSec}s ago`} stale={isStale} />
          </div>
        </div>
      </header>

      {expanded && (
        <div className="p-3 space-y-2">
          {ports.map((p) => (
            <PortRow port={p} key={p.portNumber} />
          ))}
        </div>
      )}
    </section>
  )
}

function FactCell({
  label,
  value,
  stale,
}: {
  label: string
  value: string | number
  stale?: boolean
}) {
  return (
    <div className="min-w-[80px]">
      <div className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-medium">
        {label}
      </div>
      <div
        className={cn(
          'font-mono text-sm font-semibold tabular-nums leading-tight mt-0.5',
          stale && 'text-orange-500',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function TagBadge({
  status,
  count,
}: {
  status: 'ok' | 'error' | 'warn' | 'stale' | 'pending'
  count?: number
}) {
  const map = {
    ok: { text: 'OK', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' },
    error: {
      text: count ? `${count} ERR` : 'ERROR',
      cls: 'border-red-500/40 bg-red-500/10 text-red-500',
    },
    warn: {
      text: count ? `${count} WARN` : 'WARN',
      cls: 'border-orange-500/40 bg-orange-500/10 text-orange-500',
    },
    stale: { text: 'STALE', cls: 'border-orange-500/40 bg-orange-500/10 text-orange-500' },
    pending: { text: 'WAITING', cls: 'border-muted-foreground/30 bg-muted/40 text-muted-foreground' },
  } as const
  const { text, cls } = map[status]
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded-sm border text-[10px] font-bold uppercase tracking-[0.14em]',
        cls,
      )}
    >
      {text}
    </span>
  )
}

function Chip({
  kind,
  title,
  children,
}: {
  /** All chips currently denote errors. Kept as a discriminator for future soft-warning chips. */
  kind: 'error'
  title?: string
  children: React.ReactNode
}) {
  void kind
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border text-[10px] font-semibold uppercase tracking-wider font-mono border-red-500/40 bg-red-500/10 text-red-500"
    >
      <ServerCrash className="w-2.5 h-2.5" />
      {children}
    </span>
  )
}

// ─── Port row (one row per port, three panels) ──────────────────────────

// Memoized: a port's panels depend only on its `port` snapshot, never on the
// 1s `now` ticker that re-renders the parent DeviceSection every second. The
// `port` reference is stable between server snapshots (~60s cadence), so memo
// holds across now-ticks and busts only when fresh data arrives. This is what
// keeps the GLOBAL diagnostics view (N devices × 32 ports × ~29 counters) from
// re-rendering the entire matrix once per second.
const PortRow = memo(function PortRow({ port: p }: { port: Port }) {
  const media = hasMediaErrors(p)
  const down = isActivelyDown(p)
  const ifErr = p.errorsIn > 0 || p.errorsOut > 0
  const hwFault = p.hardwareFault
  const hasError = media || down || ifErr || hwFault
  const discardsOnly =
    !hasError && (p.discardsIn > 0 || p.discardsOut > 0)
  return (
    <div
      className={cn(
        'border rounded bg-background/40 overflow-hidden',
        hasError && 'border-red-500/50 shadow-[inset_2px_0_0_0_theme(colors.red.500)]',
        !hasError && discardsOnly && 'border-orange-500/40 shadow-[inset_2px_0_0_0_theme(colors.orange.500)]',
        !hasError && !discardsOnly && 'shadow-[inset_2px_0_0_0_theme(colors.border)]',
      )}
    >
      <div className="px-3 py-1.5 border-b bg-muted/20 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <h3
            className={cn(
              'font-mono text-xs font-bold tracking-tight uppercase tabular-nums',
              hasError && 'text-red-500',
              !hasError && discardsOnly && 'text-orange-500',
            )}
          >
            Port {String(p.portNumber).padStart(2, '0')}
          </h3>
          <LinkBadges port={p} />
        </div>
        {hasError && (
          <span className="text-[9px] uppercase tracking-widest font-bold font-mono text-red-500">
            {[
              down && 'down',
              media && 'media err',
              ifErr && 'if err',
              hwFault && 'hw fault',
            ]
              .filter(Boolean)
              .join(' + ')}
          </span>
        )}
        {!hasError && discardsOnly && (
          <span className="text-[9px] uppercase tracking-widest font-bold font-mono text-orange-500">
            discards
          </span>
        )}
      </div>
      <div className="p-2 grid grid-cols-1 md:grid-cols-3 gap-2">
        <Panel title="Link">
          <KV k="Link_Status_Raw" v={p.linkStatusRaw} />
          <KV k="Link_Up" v={p.linkUp ? 1 : 0} />
          <KV k="Full_Duplex" v={p.fullDuplex ? 1 : 0} />
          <KV k="Reset_Required" v={p.resetRequired ? 1 : 0} />
          <KV k="Hardware_Fault" v={p.hardwareFault ? 1 : 0} highlight={p.hardwareFault ? 'red' : undefined} />
          <KV k="AdminState" v={p.adminState} highlight={p.adminState === 2 ? 'amber' : undefined} />
        </Panel>
        <Panel title="Interface Counters">
          <KV k="OctetsIn" v={p.octetsIn} />
          <KV k="UcastIn" v={p.ucastIn} />
          <KV k="NUcastIn" v={p.nucastIn} />
          <KV k="DiscardsIn" v={p.discardsIn} highlight={p.discardsIn > 0 ? 'amber' : undefined} />
          <KV k="ErrorsIn" v={p.errorsIn} highlight={p.errorsIn > 0 ? 'red' : undefined} />
          <KV k="UnknownProtosIn" v={p.unknownProtosIn} />
          <KV k="OctetsOut" v={p.octetsOut} />
          <KV k="UcastOut" v={p.ucastOut} />
          <KV k="NUcastOut" v={p.nucastOut} />
          <KV k="DiscardsOut" v={p.discardsOut} highlight={p.discardsOut > 0 ? 'amber' : undefined} />
          <KV k="ErrorsOut" v={p.errorsOut} highlight={p.errorsOut > 0 ? 'red' : undefined} />
        </Panel>
        <Panel title="Media Counters" errorPanel={media}>
          {/* Every media counter is a physical-layer fault when non-zero —
              highlight in red so the specific failure mode (alignment, FCS,
              late collisions, etc.) is obvious without scanning. */}
          <KV k="AlignErr" v={p.alignErr} highlight={p.alignErr > 0 ? 'red' : undefined} />
          <KV k="FCSErr" v={p.fcsErr} highlight={p.fcsErr > 0 ? 'red' : undefined} />
          <KV k="SingleColl" v={p.singleColl} highlight={p.singleColl > 0 ? 'red' : undefined} />
          <KV k="MultiColl" v={p.multiColl} highlight={p.multiColl > 0 ? 'red' : undefined} />
          <KV k="SQEErr" v={p.sqeErr} highlight={p.sqeErr > 0 ? 'red' : undefined} />
          <KV k="DeferredTx" v={p.deferredTx} highlight={p.deferredTx > 0 ? 'red' : undefined} />
          <KV k="LateColl" v={p.lateColl} highlight={p.lateColl > 0 ? 'red' : undefined} />
          <KV k="ExcessColl" v={p.excessColl} highlight={p.excessColl > 0 ? 'red' : undefined} />
          <KV k="MACTxErr" v={p.macTxErr} highlight={p.macTxErr > 0 ? 'red' : undefined} />
          <KV k="CarrierSense" v={p.carrierSense} highlight={p.carrierSense > 0 ? 'red' : undefined} />
          <KV k="FrameTooLong" v={p.frameTooLong} highlight={p.frameTooLong > 0 ? 'red' : undefined} />
          <KV k="MACRxErr" v={p.macRxErr} highlight={p.macRxErr > 0 ? 'red' : undefined} />
        </Panel>
      </div>
    </div>
  )
})

function LinkBadges({ port: p }: { port: Port }) {
  if (!p.linkUp) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-muted-foreground/30 bg-muted/40 text-muted-foreground text-[9px] font-bold uppercase tracking-[0.14em]">
        link down
      </span>
    )
  }
  return (
    <div className="flex items-center gap-1">
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase tracking-[0.14em]">
        <span className="w-1 h-1 rounded-full bg-emerald-500 status-pulse" />
        up
      </span>
      {p.speedMbps > 0 && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-primary/40 bg-primary/10 text-primary text-[9px] font-bold font-mono tracking-wider">
          {p.speedMbps >= 1000 ? `${p.speedMbps / 1000}G` : `${p.speedMbps}M`}
        </span>
      )}
      <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-foreground/15 bg-foreground/5 text-foreground/75 text-[9px] font-bold uppercase tracking-[0.14em]">
        {p.fullDuplex ? 'FDX' : 'HDX'}
      </span>
      {p.hardwareFault && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-red-500/40 bg-red-500/10 text-red-500 text-[9px] font-bold uppercase tracking-[0.14em]">
          HW
        </span>
      )}
    </div>
  )
}

function Panel({
  title,
  errorPanel,
  children,
}: {
  title: string
  /** Renders the panel in RED (physical-layer errors present). Used by Media Counters when any counter > 0. */
  errorPanel?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded border bg-card/60 px-2.5 py-1.5',
        errorPanel && 'border-red-500/30 bg-red-500/[0.04]',
      )}
    >
      <h4
        className={cn(
          'text-[9px] font-bold uppercase tracking-[0.22em] mb-1 pb-1 border-b border-border/60',
          errorPanel ? 'text-red-500' : 'text-muted-foreground',
        )}
      >
        {title}
      </h4>
      <table className="w-full">
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function KV({
  k,
  v,
  highlight,
}: {
  k: string
  v: number
  highlight?: 'amber' | 'red'
}) {
  const isZero = v === 0
  return (
    <tr
      className={cn(
        'border-b border-border/30 last:border-0',
        isZero && 'text-muted-foreground/40',
      )}
    >
      <td className="font-mono text-[10px] py-[3px] pr-2 leading-tight">{k}</td>
      <td
        className={cn(
          'font-mono text-[11px] py-[3px] text-right tabular-nums leading-tight',
          highlight === 'red' && 'text-red-500 font-bold',
          highlight === 'amber' && 'text-orange-500 font-bold',
        )}
      >
        {typeof v === 'string' ? v : formatNumber(v)}
      </td>
    </tr>
  )
}

// ─── Skeleton (no live snapshot yet) ────────────────────────────────────

// Memoized for the same reason as PortRow: the skeleton's placeholder rows
// (one per visible port — 32 for the Octopus switch, 2 for everything else)
// depend only on { deviceName, active }, not on the 1s `now` tick. Without this
// the global view re-renders every skeleton device's placeholder rows once
// per second while waiting for the first snapshot.
const SkeletonSection = memo(function SkeletonSection({ deviceName, active }: { deviceName: string; active: boolean }) {
  return (
    <section
      id={`${deviceName}_NN`}
      className="border border-dashed bg-card/50 rounded-md overflow-hidden opacity-90 scroll-mt-4"
    >
      <header className="px-5 py-3 border-b bg-muted/20">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="font-mono text-base font-bold tracking-tight text-muted-foreground">
                {deviceName}
              </h2>
              <TagBadge status="pending" />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 max-w-prose uppercase tracking-wider">
              {active
                ? `Awaiting first UDT snapshot — values fill on the next poll of ${deviceName}_NN`
                : 'Diagnostics view inactive'}
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-5 gap-y-1.5 shrink-0">
            <FactCell label="Product Code" value="—" />
            <FactCell label="Firmware" value="—" />
            <FactCell label="Active Ports" value="—" />
            <FactCell label="Last Snapshot" value="never" />
          </div>
        </div>
      </header>
      <div className="p-3 space-y-2">
        {Array.from({ length: portCapFor(deviceName) }, (_, i) => (
          <PlaceholderPortRow portNumber={i + 1} key={i + 1} />
        ))}
      </div>
    </section>
  )
})

function PlaceholderPortRow({ portNumber }: { portNumber: number }) {
  return (
    <div className="border border-border/60 rounded bg-background/30 overflow-hidden shadow-[inset_2px_0_0_0_theme(colors.border)] opacity-60">
      <div className="px-3 py-1.5 border-b bg-muted/10 flex items-center gap-2.5">
        <h3 className="font-mono text-xs font-bold tracking-tight uppercase tabular-nums text-muted-foreground">
          Port {String(portNumber).padStart(2, '0')}
        </h3>
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-muted-foreground/30 bg-muted/30 text-muted-foreground text-[9px] font-bold uppercase tracking-[0.14em]">
          —
        </span>
      </div>
      <div className="p-2 grid grid-cols-1 md:grid-cols-3 gap-2">
        <PlaceholderPanel
          title="Link"
          keys={['Link_Status_Raw', 'Link_Up', 'Full_Duplex', 'Reset_Required', 'Hardware_Fault', 'AdminState']}
        />
        <PlaceholderPanel
          title="Interface Counters"
          keys={[
            'OctetsIn', 'UcastIn', 'NUcastIn', 'DiscardsIn', 'ErrorsIn', 'UnknownProtosIn',
            'OctetsOut', 'UcastOut', 'NUcastOut', 'DiscardsOut', 'ErrorsOut',
          ]}
        />
        <PlaceholderPanel
          title="Media Counters"
          keys={[
            'AlignErr', 'FCSErr', 'SingleColl', 'MultiColl', 'SQEErr', 'DeferredTx',
            'LateColl', 'ExcessColl', 'MACTxErr', 'CarrierSense', 'FrameTooLong', 'MACRxErr',
          ]}
        />
      </div>
    </div>
  )
}

function PlaceholderPanel({ title, keys }: { title: string; keys: string[] }) {
  return (
    <div className="rounded border bg-card/40 px-2.5 py-1.5">
      <h4 className="text-[9px] font-bold uppercase tracking-[0.22em] mb-1 pb-1 border-b border-border/60 text-muted-foreground/60">
        {title}
      </h4>
      <table className="w-full">
        <tbody>
          {keys.map((k) => (
            <tr key={k} className="border-b border-border/30 last:border-0 text-muted-foreground/40">
              <td className="font-mono text-[10px] py-[3px] pr-2 leading-tight">{k}</td>
              <td className="font-mono text-[11px] py-[3px] text-right tabular-nums leading-tight">—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
