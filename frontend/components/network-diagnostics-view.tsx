"use client"

/**
 * Full-page live network diagnostics dashboard.
 *
 * Subscribes to the server's WS feed, accumulates one snapshot per
 * `<DeviceName>_NetworkNode` tag, and renders a layout that mirrors the
 * `IOCT_COMMUNICATION_MONITOR_Routine_RLL_nn_values.html` report:
 *
 *   - Top-of-page table of contents grouped by device type (DPM / FIOM /
 *     VFD / EX / SIO / VR / VSU / POINT_IO / LPE / Unknown). Each device
 *     card shows status (ok / down / media) and chips for any per-port
 *     issues.
 *   - One <section> per device with header (name + warn count + chips),
 *     facts row (Product Code / Firmware / Active Ports), and a grid of
 *     per-port cards.
 *   - Each port card has three panels: Link, Interface Counters,
 *     Media Counters. Zero-valued rows are muted, ports with media-counter
 *     errors get an amber accent, ports with linkUp=false and historical
 *     traffic get a red accent.
 *
 * The CSS is inlined verbatim from the reference HTML so this view always
 * looks the same regardless of the surrounding Tailwind theme.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { NetworkDeviceSnapshotMessage } from '@/lib/plc/types'

type Snapshot = NetworkDeviceSnapshotMessage['snapshot']
type Port = Snapshot['ports'][number]

interface Props {
  /** Drop the snapshot cache and tear down WS when false. */
  active: boolean
}

const STALE_MS = 60_000 // device considered "down" if no snapshot in this window

/**
 * Group label derived from the PLC device name. Mirrors the existing
 * `getDeviceType` in network-topology-view.tsx but kept local so this view
 * doesn't import from a 1000+-line file.
 */
function deviceTypeOf(name: string): string {
  if (name.includes('VFD')) return 'VFD'
  if (name.includes('FIOM')) return 'FIOM'
  if (name.includes('PMM')) return 'PMM'
  if (name.includes('SIO')) return 'SIO'
  if (name.includes('VSU')) return 'VSU'
  if (/(^|_)VR(_|$)/.test(name)) return 'VR'
  if (/(^|_)EX(_|$)/.test(name)) return 'EX'
  if (name.includes('LPE')) return 'LPE'
  if (name.includes('POINT')) return 'POINT_IO'
  if (name.includes('DPM') || name.includes('EN4TR') || name.includes('EN2TR')) return 'DPM'
  return 'Other'
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

// === Per-port status helpers ===

function hasMediaErrors(p: Port): boolean {
  return (
    p.alignErr > 0 ||
    p.fcsErr > 0 ||
    p.singleColl > 0 ||
    p.multiColl > 0 ||
    p.sqeErr > 0 ||
    p.deferredTx > 0 ||
    p.lateColl > 0 ||
    p.excessColl > 0 ||
    p.macTxErr > 0 ||
    p.carrierSense > 0 ||
    p.frameTooLong > 0 ||
    p.macRxErr > 0
  )
}

function hasInterfaceErrors(p: Port): boolean {
  return p.errorsIn > 0 || p.errorsOut > 0 || p.discardsIn > 0 || p.discardsOut > 0
}

/**
 * A port is "actively down" when it isn't linked but has had historical
 * traffic (octets > 0). Ports that have never seen traffic AND aren't linked
 * are just unused — we don't flag those.
 */
function isActivelyDown(p: Port): boolean {
  if (p.linkUp) return false
  return p.octetsIn > 0 || p.octetsOut > 0
}

// === Aggregations per device ===

interface DeviceSummary {
  activePorts: number
  warnCount: number
  downCount: number
  mediaCount: number
  mediaPorts: Port[]
  downPorts: Port[]
}

function summarize(snap: Snapshot): DeviceSummary {
  let activePorts = 0
  let downCount = 0
  let mediaCount = 0
  let warnCount = 0
  const mediaPorts: Port[] = []
  const downPorts: Port[] = []
  for (const p of snap.ports) {
    if (p.linkUp) activePorts++
    if (hasMediaErrors(p)) {
      mediaCount++
      mediaPorts.push(p)
      warnCount++
    }
    if (isActivelyDown(p)) {
      downCount++
      downPorts.push(p)
      warnCount++
    } else if (!hasMediaErrors(p) && hasInterfaceErrors(p)) {
      warnCount++
    }
  }
  return { activePorts, warnCount, downCount, mediaCount, mediaPorts, downPorts }
}

type DeviceCardStatus = 'ok' | 'down' | 'media'

function tocStatusOf(snap: Snapshot | null, lastSeen: number, now: number, summary: DeviceSummary | null): DeviceCardStatus {
  if (!snap || now - lastSeen > STALE_MS) return 'down'
  if (summary && summary.mediaCount > 0) return 'media'
  return 'ok'
}

// === Component ===

interface DeviceState {
  snapshot: Snapshot
  lastSeen: number
}

export function NetworkDiagnosticsView({ active }: Props) {
  const [devices, setDevices] = useState<Map<string, DeviceState>>(new Map())
  const [wsConnected, setWsConnected] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // 1-second tick so the "Xs ago" / staleness check stays current without
  // re-rendering on every WS message.
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])

  // WS subscription scoped to view active state.
  useEffect(() => {
    if (!active) {
      setDevices(new Map())
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
          const snapshot = msg.snapshot
          setDevices((prev) => {
            const next = new Map(prev)
            next.set(snapshot.deviceName, { snapshot, lastSeen: Date.now() })
            return next
          })
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
  }, [active])

  /** Devices grouped by deviceType, sorted alphabetically inside each group. */
  const groups = useMemo(() => {
    const map = new Map<string, DeviceState[]>()
    for (const ds of Array.from(devices.values())) {
      const g = deviceTypeOf(ds.snapshot.deviceName)
      const list = map.get(g) ?? []
      list.push(ds)
      map.set(g, list)
    }
    for (const list of Array.from(map.values())) {
      list.sort((a, b) => a.snapshot.deviceName.localeCompare(b.snapshot.deviceName))
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [devices])

  const totalDevices = devices.size
  const totalGroups = groups.length

  return (
    <div className="net-diag">
      <style>{DIAG_CSS}</style>

      <h1>
        Network Diagnostics
        <span className="sub">
          {totalDevices} tag{totalDevices === 1 ? '' : 's'} · {totalGroups} group{totalGroups === 1 ? '' : 's'} ·{' '}
          {wsConnected ? 'live' : 'reconnecting…'}
        </span>
      </h1>

      {totalDevices === 0 && (
        <p className="empty">
          {active
            ? 'No network device snapshots received yet. Make sure networkPollingEnabled is true and the PLC is connected.'
            : 'Diagnostics view inactive.'}
        </p>
      )}

      {totalDevices > 0 && (
        <>
          <NavToc groups={groups} now={now} />

          {groups.map(([groupName, deviceList]) => (
            <div className="group" key={groupName} id={`grp-${groupName}`}>
              <h2 className="group-head">
                {groupName} <span className="group-cnt">{deviceList.length} tag{deviceList.length === 1 ? '' : 's'}</span>
              </h2>
              {deviceList.map((ds) => (
                <DeviceSection key={ds.snapshot.deviceName} state={ds} now={now} />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// === TOC ===

function NavToc({ groups, now }: { groups: [string, DeviceState[]][]; now: number }) {
  return (
    <nav className="toc">
      <strong>Quick jump</strong>
      <div className="toc-grid">
        {groups.map(([groupName, deviceList]) => (
          <div className="toc-group" key={groupName}>
            <a className="toc-grp-head" href={`#grp-${groupName}`}>
              <span>{groupName}</span>
              <span className="cnt">{deviceList.length} tags</span>
            </a>
            <div className="toc-cards">
              {deviceList.map((ds) => {
                const summary = summarize(ds.snapshot)
                const status = tocStatusOf(ds.snapshot, ds.lastSeen, now, summary)
                const chips: string[] = []
                if (summary.mediaCount > 0) chips.push(`${summary.mediaCount} MEDIA`)
                if (summary.downCount > 0) chips.push(`${summary.downCount} DOWN`)
                return (
                  <a className={`toc-card ${status}`} href={`#${ds.snapshot.deviceName}_NN`} key={ds.snapshot.deviceName}>
                    <div className="toc-card-head">
                      <span className="dot">●</span>
                      <span>{ds.snapshot.deviceName}</span>
                    </div>
                    <div className="toc-card-sub">
                      {summary.activePorts}/32 active · {summary.warnCount === 0 ? 'no issues' : `${summary.warnCount} warn`}
                    </div>
                    {chips.length > 0 && (
                      <div className="toc-chips">
                        {chips.map((c) => (
                          <span className={`chip ${c.includes('MEDIA') ? 'media' : 'down'}`} key={c}>{c}</span>
                        ))}
                      </div>
                    )}
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

// === Device section ===

function DeviceSection({ state, now }: { state: DeviceState; now: number }) {
  const { snapshot, lastSeen } = state
  const summary = useMemo(() => summarize(snapshot), [snapshot])
  const isStale = now - lastSeen > STALE_MS

  const tagStatus: 'ok' | 'warn' = summary.warnCount > 0 || isStale ? 'warn' : 'ok'
  const chips: { text: string; kind: 'media' | 'down'; title: string }[] = [
    ...summary.mediaPorts.map((p) => ({
      text: `P${p.portNumber} MEDIA ERR`,
      kind: 'media' as const,
      title: `AlignErr=${p.alignErr}, FCSErr=${p.fcsErr}, MACRxErr=${p.macRxErr}`,
    })),
    ...summary.downPorts.map((p) => ({
      text: `P${p.portNumber} DOWN`,
      kind: 'down' as const,
      title: `OctetsIn=${p.octetsIn}, OctetsOut=${p.octetsOut}`,
    })),
  ]

  const ageSec = Math.max(0, Math.floor((now - snapshot.capturedAt) / 1000))

  return (
    <section className="nn wide" id={`${snapshot.deviceName}_NN`}>
      <div className="nn-head">
        <div className="nn-title">
          <h2>
            {snapshot.deviceName}{' '}
            <span className={`tag-status ${tagStatus}`}>
              {isStale ? 'STALE' : tagStatus === 'ok' ? 'OK' : summary.warnCount}
            </span>
          </h2>
          {chips.length > 0 && (
            <div className="chips">
              {chips.map((c) => (
                <span className={`chip ${c.kind}`} title={c.title} key={c.text}>{c.text}</span>
              ))}
            </div>
          )}
        </div>
        <div className="facts">
          <div>
            <span className="lbl">Product Code</span>
            <span className="val">{snapshot.productCode || '—'}</span>
          </div>
          <div>
            <span className="lbl">Firmware</span>
            <span className="val">
              {snapshot.firmwareMajor || snapshot.firmwareMinor
                ? `${snapshot.firmwareMajor}.${snapshot.firmwareMinor}`
                : '—'}
            </span>
          </div>
          <div>
            <span className="lbl">Active Ports</span>
            <span className="val">{summary.activePorts}</span>
          </div>
          <div>
            <span className="lbl">Last Snapshot</span>
            <span className="val">{ageSec}s ago</span>
          </div>
        </div>
      </div>
      <div className="ports">
        {snapshot.ports.map((p) => (
          <PortCard port={p} key={p.portNumber} />
        ))}
      </div>
    </section>
  )
}

// === Port card ===

function PortCard({ port: p }: { port: Port }) {
  const media = hasMediaErrors(p)
  const down = isActivelyDown(p)
  return (
    <div className={`port${media ? ' has-media' : ''}${down ? ' has-down' : ''}`}>
      <div className="port-head">
        <h3>Port [{p.portNumber}]</h3>
        <div className="badges">
          <span className={`badge ${p.linkUp ? 'up' : 'down'}`}>{p.linkUp ? 'LINK UP' : 'LINK DOWN'}</span>
          {p.linkUp && p.speedMbps > 0 && <span className="badge speed">{p.speedMbps} Mbps</span>}
          {p.linkUp && <span className="badge dup">{p.fullDuplex ? 'Full Duplex' : 'Half Duplex'}</span>}
          {p.hardwareFault && <span className="badge warn">HW Fault</span>}
        </div>
      </div>
      <div className="port-grid">
        <Panel title="Link">
          <KV k="Link_Status_Raw" v={p.linkStatusRaw} />
          <KV k="Link_Up" v={p.linkUp ? 1 : 0} />
          <KV k="Full_Duplex" v={p.fullDuplex ? 1 : 0} />
          <KV k="Reset_Required" v={p.resetRequired ? 1 : 0} />
          <KV k="Hardware_Fault" v={p.hardwareFault ? 1 : 0} />
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
        <Panel title="Media Counters" mediaPanel={media}>
          <KV k="AlignErr" v={p.alignErr} />
          <KV k="FCSErr" v={p.fcsErr} />
          <KV k="SingleColl" v={p.singleColl} />
          <KV k="MultiColl" v={p.multiColl} />
          <KV k="SQEErr" v={p.sqeErr} />
          <KV k="DeferredTx" v={p.deferredTx} />
          <KV k="LateColl" v={p.lateColl} />
          <KV k="ExcessColl" v={p.excessColl} />
          <KV k="MACTxErr" v={p.macTxErr} />
          <KV k="CarrierSense" v={p.carrierSense} />
          <KV k="FrameTooLong" v={p.frameTooLong} />
          <KV k="MACRxErr" v={p.macRxErr} />
        </Panel>
      </div>
    </div>
  )
}

function Panel({
  title,
  mediaPanel,
  children,
}: {
  title: string
  mediaPanel?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`panel${mediaPanel ? ' media-panel' : ''}`}>
      <h4>{title}</h4>
      <table className="kv">
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function KV({ k, v, highlight }: { k: string; v: number; highlight?: 'amber' | 'red' }) {
  const isZero = v === 0
  return (
    <tr className={isZero ? 'zero' : ''}>
      <td className="k">{k}</td>
      <td className={`v${highlight ? ` hi-${highlight}` : ''}`}>{formatNumber(v)}</td>
    </tr>
  )
}

// === CSS ===
// Ported from IOCT_COMMUNICATION_MONITOR_Routine_RLL_nn_values.html. Scoped
// under .net-diag so it doesn't bleed into the rest of the app.
const DIAG_CSS = `
.net-diag {
  --d-bg: #0f1419;
  --d-card: #1a2027;
  --d-card2: #232a33;
  --d-border: #2d3742;
  --d-text: #d9e0e8;
  --d-muted: #7a8694;
  --d-accent: #4ea1ff;
  --d-accent2: #79d1ff;
  --d-green: #3ecf8e;
  --d-red: #ff5d6c;
  --d-amber: #ffb454;
  --d-zero: #4b545f;
  background: var(--d-bg);
  color: var(--d-text);
  font-family: 'Segoe UI', -apple-system, Arial, sans-serif;
  line-height: 1.4;
  padding: 1.5em;
  min-height: 100%;
  border-radius: 8px;
}
.net-diag * { box-sizing: border-box; }
.net-diag h1 { font-weight: 300; letter-spacing: 0.5px; border-bottom: 1px solid var(--d-border); padding-bottom: 0.4em; margin: 0 0 1em; }
.net-diag h1 .sub { color: var(--d-muted); font-size: 0.55em; margin-left: 1em; font-weight: 400; }
.net-diag .empty { color: var(--d-muted); padding: 2em; text-align: center; }

.net-diag nav.toc {
  background: var(--d-card); border: 1px solid var(--d-border); border-radius: 8px;
  padding: 0.8em 1.2em; margin: 0 0 2em;
}
.net-diag nav.toc strong { color: var(--d-accent2); }
.net-diag nav.toc .toc-grid { display: flex; flex-direction: column; gap: 1.2em; margin-top: 0.8em; }
.net-diag nav.toc .toc-group { background: rgba(0,0,0,0.18); border-radius: 8px; padding: 0.9em 1.2em; }
.net-diag nav.toc .toc-grp-head {
  display: flex; justify-content: space-between; align-items: center;
  color: var(--d-accent2); font-weight: 600; text-decoration: none; font-size: 0.95em;
  padding-bottom: 0.3em; margin-bottom: 0.3em; border-bottom: 1px solid var(--d-border);
}
.net-diag nav.toc .toc-grp-head .cnt {
  background: rgba(78,161,255,0.18); color: var(--d-accent); border: 1px solid rgba(78,161,255,0.4);
  padding: 1px 7px; border-radius: 10px; font-size: 0.75em; font-weight: 600;
}
.net-diag nav.toc .toc-cards {
  display: grid; gap: 0.5em; margin-top: 0.6em;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}
.net-diag nav.toc .toc-card {
  display: flex; flex-direction: column; gap: 0.3em;
  text-decoration: none; color: inherit;
  background: rgba(0,0,0,0.22); border: 1px solid var(--d-border); border-left: 3px solid;
  border-radius: 5px; padding: 0.5em 0.7em;
  transition: transform 0.08s, background 0.08s, border-color 0.08s;
}
.net-diag nav.toc .toc-card.ok    { border-left-color: rgba(62,207,142,0.5); }
.net-diag nav.toc .toc-card.down  { border-left-color: var(--d-red); background: rgba(255,93,108,0.06); }
.net-diag nav.toc .toc-card.media {
  border-left-color: var(--d-amber);
  background: linear-gradient(90deg, rgba(255,180,84,0.15), rgba(255,180,84,0.04));
  border-color: rgba(255,180,84,0.4);
  box-shadow: 0 0 0 1px rgba(255,180,84,0.2);
}
.net-diag nav.toc .toc-card:hover { background: rgba(78,161,255,0.12); border-color: var(--d-accent); transform: translateX(2px); }
.net-diag nav.toc .toc-card.media:hover { background: rgba(255,180,84,0.22); border-color: var(--d-amber); }
.net-diag nav.toc .toc-card-head { display: flex; align-items: center; gap: 0.4em; font-weight: 600; }
.net-diag nav.toc .toc-card-sub { color: var(--d-muted); font-size: 0.75em; }
.net-diag nav.toc .dot { font-size: 0.65em; }
.net-diag nav.toc .toc-card.ok    .dot { color: var(--d-green); }
.net-diag nav.toc .toc-card.down  .dot { color: var(--d-red); }
.net-diag nav.toc .toc-card.media .dot { color: var(--d-amber); }
.net-diag nav.toc .toc-chips { display: flex; gap: 0.25em; flex-wrap: wrap; }
.net-diag nav.toc .toc-chips .chip { padding: 1px 6px; font-size: 0.62em; border-radius: 8px; line-height: 1.4; }

.net-diag .group { margin-bottom: 1.5em; }
.net-diag .group-head {
  color: var(--d-accent2); font-weight: 500; font-size: 1.15em;
  border-bottom: 1px solid var(--d-border); padding-bottom: 0.3em; margin: 1.5em 0 0.8em;
}
.net-diag .group-cnt {
  background: rgba(121,209,255,0.15); color: var(--d-accent2);
  padding: 2px 10px; border-radius: 12px; font-size: 0.65em; font-weight: 600; margin-left: 0.6em;
}

.net-diag section.nn { scroll-margin-top: 1em; background: var(--d-card); border: 1px solid var(--d-border); border-radius: 8px; margin-bottom: 1.2em; overflow: hidden; }
.net-diag section.nn:target .nn-head { box-shadow: 0 0 0 2px var(--d-accent) inset; }
.net-diag .nn-head { padding: 1em 1.4em; border-bottom: 1px solid var(--d-border); background: rgba(0,0,0,0.18); display: flex; justify-content: space-between; align-items: center; gap: 1em; flex-wrap: wrap; }
.net-diag .nn-title { display: flex; flex-direction: column; gap: 0.4em; }
.net-diag .nn-head h2 { margin: 0; color: var(--d-accent2); font-family: Consolas, monospace; font-size: 1.15em; font-weight: 600; }
.net-diag .tag-status { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: 0.65em; font-weight: 700; margin-left: 0.5em; letter-spacing: 0.4px; }
.net-diag .tag-status.ok   { background: rgba(62,207,142,0.15); color: var(--d-green); border: 1px solid rgba(62,207,142,0.4); }
.net-diag .tag-status.warn { background: rgba(255,180,84,0.18); color: var(--d-amber); border: 1px solid rgba(255,180,84,0.5); }
.net-diag .chips { display: flex; gap: 0.3em; flex-wrap: wrap; }
.net-diag .chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.7em; font-weight: 600; letter-spacing: 0.3px; }
.net-diag .chip.down  { background: rgba(255,93,108,0.15); color: var(--d-red); border: 1px solid rgba(255,93,108,0.45); }
.net-diag .chip.media { background: rgba(255,180,84,0.2); color: var(--d-amber); border: 1px solid rgba(255,180,84,0.5); }

.net-diag .facts { display: flex; gap: 1.5em; flex-wrap: wrap; }
.net-diag .facts > div { display: flex; flex-direction: column; gap: 0.1em; min-width: 90px; }
.net-diag .facts .lbl { color: var(--d-muted); font-size: 0.7em; letter-spacing: 0.5px; text-transform: uppercase; }
.net-diag .facts .val { color: var(--d-text); font-family: Consolas, monospace; font-size: 1em; }

.net-diag .ports { padding: 1em 1.4em 1.4em; display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 1em; }
.net-diag .port { background: var(--d-card2); border: 1px solid var(--d-border); border-radius: 8px; padding: 0.8em 1em; border-left: 4px solid var(--d-border); }
.net-diag .port.has-media {
  border-left-color: var(--d-amber);
  background: linear-gradient(180deg, rgba(255,180,84,0.10), rgba(255,180,84,0.03));
  box-shadow: 0 0 0 1px rgba(255,180,84,0.25);
}
.net-diag .port.has-media .port-head h3 { color: var(--d-amber); }
.net-diag .port.has-down {
  border-left-color: var(--d-red);
  background: linear-gradient(180deg, rgba(255,93,108,0.08), rgba(255,93,108,0.02));
}
.net-diag .port.has-down .port-head h3 { color: var(--d-red); }
.net-diag .port-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5em; margin-bottom: 0.6em; }
.net-diag .port-head h3 { margin: 0; font-size: 0.95em; color: var(--d-accent); font-family: Consolas, monospace; }
.net-diag .badges { display: flex; gap: 0.35em; flex-wrap: wrap; }
.net-diag .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.7em; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; }
.net-diag .badge.up    { background: rgba(62,207,142,0.15); color: var(--d-green); border: 1px solid rgba(62,207,142,0.4); }
.net-diag .badge.down  { background: rgba(255,93,108,0.15); color: var(--d-red); border: 1px solid rgba(255,93,108,0.4); }
.net-diag .badge.dup   { background: rgba(78,161,255,0.15); color: var(--d-accent); border: 1px solid rgba(78,161,255,0.4); }
.net-diag .badge.speed { background: rgba(121,209,255,0.12); color: var(--d-accent2); border: 1px solid rgba(121,209,255,0.35); }
.net-diag .badge.warn  { background: rgba(255,180,84,0.2); color: var(--d-amber); border: 1px solid rgba(255,180,84,0.5); }

.net-diag .port-grid { display: grid; gap: 0.7em; grid-template-columns: 1fr; }
@media (min-width: 1200px) {
  .net-diag .port-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
.net-diag .panel { background: rgba(0,0,0,0.18); border: 1px solid var(--d-border); border-radius: 6px; padding: 0.5em 0.8em; }
.net-diag .panel h4 { margin: 0 0 0.4em; color: var(--d-accent2); font-size: 0.75em; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; }
.net-diag .panel.media-panel { background: rgba(255,180,84,0.08); border: 1px solid rgba(255,180,84,0.3); }
.net-diag .panel.media-panel h4 { color: var(--d-amber); }
.net-diag .panel.media-panel td.v:not(.hi-red):not(.hi-amber) { color: var(--d-amber); }

.net-diag table.kv { width: 100%; border-collapse: collapse; font-family: Consolas, monospace; font-size: 0.78em; }
.net-diag table.kv td { padding: 1px 0; }
.net-diag table.kv td.k { color: var(--d-muted); }
.net-diag table.kv td.v { text-align: right; color: var(--d-text); }
.net-diag table.kv td.v.hi-red   { color: var(--d-red);   font-weight: 700; }
.net-diag table.kv td.v.hi-amber { color: var(--d-amber); font-weight: 700; }
.net-diag table.kv tr.zero td.v { color: var(--d-zero); }
.net-diag table.kv tr.zero td.k { color: var(--d-zero); }
`
