/**
 * System Info Collector
 *
 * Snapshots OS/CPU/memory/disk/network/PLC/sync state for a heartbeat
 * payload. Everything here is best-effort — a single failing probe
 * (e.g. wmic missing) must not break the rest of the snapshot.
 */

import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'
import { db } from '@/lib/db-sqlite'
import { resolveDatabasePath } from '@/lib/storage-paths'
import { hasPlcClient, getPlcStatus, getLatestNetworkDeviceSnapshots } from '@/lib/plc-client-manager'
import {
  getAggregateStatus,
  getAllNetworkSnapshots,
  hasAnyMcm,
} from '@/lib/mcm-registry'
import { getGatewayLinkState } from '@/lib/plc/remote-cache'
import type { NetworkDeviceSnapshot } from '@/lib/plc/network'

// Captured once at module load — the moment the server process started.
const PROCESS_STARTED_AT = new Date().toISOString()

export interface HeartbeatSystemInfo {
  os: {
    platform: string
    release: string
    arch: string
    version?: string
  }
  cpu: {
    model: string
    cores: number
  }
  memory: {
    totalMb: number
    freeMb: number
  }
  disk: {
    totalGb?: number
    freeGb?: number
    dbSizeMb?: number
  }
  ips: string[]
  nodeVersion: string
  startedAt: string
  uptimeSec: number
  plc: {
    connected: boolean
    host?: string | null
    lastError?: string | null
    /**
     * Central-tool multi-MCM rollup. When the server is configured to manage
     * multiple controllers, each is listed here. Empty/absent on legacy
     * single-PLC deployments.
     */
    mcms?: Array<{
      subsystemId: string
      name: string
      ip: string
      /**
       * CIP routing path to the controller (e.g. "1,0" = local chassis slot 0).
       * A path of only the backplane slot ("1,0"/"1,1") means the tool is
       * cabled directly to this MCM; a longer/routed path means it reaches the
       * controller through other modules. Lets the cloud distinguish the local
       * MCM from routed/remote ones without guessing from the IP.
       */
      path: string
      connected: boolean
      tagCount: number
    }>
    connectedMcmCount?: number
    totalMcmCount?: number
    /**
     * Split deployment (PLC_MODE=remote) only: TRUE when the app's poll of the
     * plc-gateway has gone stale (gateway down / unreachable). Distinct from a
     * PLC being disconnected — it means the LINK to the gateway is down and the
     * connection/tag readings are frozen, so the cloud should show "gateway link
     * stale" rather than trusting the (now forced-disconnected) MCM states.
     */
    gatewayLinkStale?: boolean
  }
  pendingSyncCount?: number
  lastCloudSyncAt?: string | null
  /**
   * True when this process is a centralized server deployment (one Node
   * process holding N live MCM connections, PLC_MODE=remote) rather than a
   * single-PLC field tablet. Lets the cloud flag the Central Server instance.
   */
  central?: boolean
  /**
   * Operator display names currently running tests through this tool. On a
   * central server this is "who is connected and working right now" across all
   * MCMs; on a field tablet it's the local operator(s). Sourced from the
   * in-process testing registry, not persisted auth.
   */
  activeOperators?: string[]
  /**
   * Most recent UDT_NETWORK_NODE_DATA snapshot per discovered device.
   * Populated when the poller has completed at least one cycle on a PLC
   * that has *_NetworkNode tags. Cloud receiver stores this inside the
   * systemInfo JSONB blob; no separate column.
   *
   * Central-tool: each snapshot is decorated with `subsystemId` so the
   * cloud can attribute diagnostics to the correct MCM.
   */
  networkDevices?: Array<NetworkDeviceSnapshot & { subsystemId?: string }>
}

function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

function bytesToGb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10
}

/**
 * Non-internal IPv4 addresses. We deliberately skip IPv6 and loopbacks
 * — the cloud just needs something operations can use to identify the
 * laptop on the local network.
 */
function collectIps(): string[] {
  const ips: string[] = []
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    const ifaces = interfaces[name]
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address)
      }
    }
  }
  return ips
}

/**
 * Windows-only: read C: drive total/free via wmic. Returns undefined
 * fields on any other platform or if wmic isn't available.
 */
function collectDisk(): { totalGb?: number; freeGb?: number } {
  if (os.platform() !== 'win32') return {}

  try {
    const stdout = execSync(
      'wmic logicaldisk where DeviceID="C:" get size,freespace /format:value',
      { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const freeMatch = stdout.match(/FreeSpace=(\d+)/)
    const sizeMatch = stdout.match(/Size=(\d+)/)
    const result: { totalGb?: number; freeGb?: number } = {}
    if (sizeMatch) result.totalGb = bytesToGb(Number(sizeMatch[1]))
    if (freeMatch) result.freeGb = bytesToGb(Number(freeMatch[1]))
    return result
  } catch {
    // wmic missing on newer Windows, or PowerShell-only host — silently skip.
    return {}
  }
}

function collectDbSizeMb(): number | undefined {
  try {
    const stat = fs.statSync(resolveDatabasePath())
    return bytesToMb(stat.size)
  } catch {
    return undefined
  }
}

function collectPlcStatus(): HeartbeatSystemInfo['plc'] {
  // Multi-MCM path: when the registry has entries, return the per-MCM
  // rollup. Legacy singleton info is still included on the top-level
  // `connected`/`host` fields so existing cloud receivers stay compatible.
  if (hasAnyMcm()) {
    try {
      const agg = getAggregateStatus()
      const firstConnected = agg.mcms.find((m) => m.connected) ?? agg.mcms[0]
      // Distinct gateway-link health (split deployment). agg is already
      // stale-forced to disconnected by getAggregateStatus; this flag tells the
      // cloud WHY (link down) vs. a genuine PLC disconnect.
      const gatewayLinkStale = isCentralDeployment() && getGatewayLinkState() === 'stale'
      return {
        connected: agg.anyConnected,
        host: firstConnected?.ip ?? null,
        lastError: null,
        mcms: agg.mcms.map((m) => ({
          subsystemId: m.subsystemId,
          name: m.name,
          ip: m.ip,
          path: m.path,
          connected: m.connected,
          tagCount: m.tagCount,
        })),
        connectedMcmCount: agg.connectedCount,
        totalMcmCount: agg.totalCount,
        ...(gatewayLinkStale ? { gatewayLinkStale: true } : {}),
      }
    } catch (err) {
      return {
        connected: false,
        host: null,
        lastError: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // Legacy singleton path (field-laptop single-PLC deployments).
  // Never construct the PLC client just to ask its status — that would
  // load libplctag on demand and could fail. Only inspect existing state.
  if (!hasPlcClient()) {
    return { connected: false, host: null, lastError: null }
  }
  try {
    const status = getPlcStatus()
    return {
      connected: status.connected,
      host: status.connectionConfig?.ip ?? null,
      lastError: null,
    }
  } catch (err) {
    return {
      connected: false,
      host: null,
      lastError: err instanceof Error ? err.message : String(err),
    }
  }
}

function collectPendingSyncCount(): number | undefined {
  try {
    // ACTIVE rows only — parked (DeadLettered=1) rows are reported as attention,
    // not as pending work waiting to sync.
    const io = (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs WHERE DeadLettered = 0').get() as { count: number }).count
    let l2 = 0
    try {
      l2 = (db.prepare('SELECT COUNT(*) as count FROM L2PendingSyncs').get() as { count: number }).count
    } catch {
      // L2PendingSyncs may not exist on very old databases.
    }
    return io + l2
  } catch {
    return undefined
  }
}

function collectLastCloudSyncAt(): string | null {
  // Lazy require to dodge the circular dependency: auto-sync imports
  // the heartbeat service, which imports this module. The auto-sync
  // module is already loaded by the time the heartbeat tick fires,
  // so a require() at call time is cheap and resolves cleanly.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAutoSyncService } = require('@/lib/cloud/auto-sync') as typeof import('@/lib/cloud/auto-sync')
    const svc = getAutoSyncService()
    if (!svc) return null
    return svc.getStatus().lastPushAt
  } catch {
    return null
  }
}

/**
 * Centralized server deployment? The central installer runs the app with
 * PLC_MODE=remote (PLC work split into a separate gateway service); the field
 * tablet runs embedded. This is the authoritative deployment-mode signal.
 */
function isCentralDeployment(): boolean {
  return String(process.env.PLC_MODE ?? '').trim().toLowerCase() === 'remote'
}

/**
 * Operator display names currently running tests through this tool, read from
 * the in-process testing registry (globalThis.isTestingUsers). Best-effort and
 * read-only — never let a missing/!Set global break the heartbeat.
 */
function collectActiveOperators(): string[] {
  try {
    const g = globalThis as unknown as { isTestingUsers?: Set<string> }
    return g.isTestingUsers instanceof Set ? Array.from(g.isTestingUsers) : []
  } catch {
    return []
  }
}

/**
 * Build the full systemInfo blob for a heartbeat payload. Pure read-only.
 */
export function collectSystemInfo(): HeartbeatSystemInfo {
  const cpus = os.cpus()
  const cpuModel = cpus[0]?.model ?? 'unknown'
  const cpuCores = cpus.length

  const disk = collectDisk()
  const dbSizeMb = collectDbSizeMb()
  const networkDevices = collectNetworkDevices()
  const activeOperators = collectActiveOperators()

  return {
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      version: typeof os.version === 'function' ? os.version() : undefined,
    },
    cpu: {
      model: cpuModel,
      cores: cpuCores,
    },
    memory: {
      totalMb: bytesToMb(os.totalmem()),
      freeMb: bytesToMb(os.freemem()),
    },
    disk: {
      ...disk,
      ...(dbSizeMb !== undefined ? { dbSizeMb } : {}),
    },
    ips: collectIps(),
    nodeVersion: process.version,
    startedAt: PROCESS_STARTED_AT,
    uptimeSec: Math.round(process.uptime()),
    plc: collectPlcStatus(),
    pendingSyncCount: collectPendingSyncCount(),
    lastCloudSyncAt: collectLastCloudSyncAt(),
    // Only emitted on central servers, so field-tablet payloads are unchanged.
    ...(isCentralDeployment() ? { central: true } : {}),
    ...(activeOperators.length > 0 ? { activeOperators } : {}),
    ...(networkDevices.length > 0 ? { networkDevices } : {}),
  }
}

/**
 * Last time we attached networkDevices to a heartbeat. We downsample the
 * cloud-side delivery to once per NETWORK_DEVICES_HEARTBEAT_INTERVAL_MS so
 * the heartbeat payload doesn't balloon. The WS broadcast (separate path) is
 * unaffected and keeps emitting every 5 s for the live diagnostics drawer.
 *
 * Rough math at 4 devices × ~9 KB each: shipping every 10 s heartbeat would
 * be ~3.6 KB/s baseline (~310 MB/day uploaded per laptop and stored as JSONB
 * on the cloud). Downsampling to once per minute brings that to ~50 MB/day.
 */
let lastNetworkDevicesAttachedAt = 0
const NETWORK_DEVICES_HEARTBEAT_INTERVAL_MS = 60_000

function collectNetworkDevices(): Array<NetworkDeviceSnapshot & { subsystemId?: string }> {
  const now = Date.now()
  if (now - lastNetworkDevicesAttachedAt < NETWORK_DEVICES_HEARTBEAT_INTERVAL_MS) {
    return []
  }
  // Best-effort: never let a poller crash break the heartbeat.
  try {
    // Multi-MCM: union of every MCM's network snapshots, each tagged with
    // its owning subsystemId. Legacy single-PLC path emits unattributed
    // snapshots (cloud receiver treats absence of subsystemId as the default
    // subsystem from the heartbeat payload).
    const snapshots = hasAnyMcm()
      ? getAllNetworkSnapshots()
      : getLatestNetworkDeviceSnapshots()
    if (snapshots.length > 0) {
      lastNetworkDevicesAttachedAt = now
    }
    return snapshots
  } catch (err) {
    console.warn(
      '[Heartbeat] Failed to read network device snapshots:',
      err instanceof Error ? err.message : err,
    )
    return []
  }
}
