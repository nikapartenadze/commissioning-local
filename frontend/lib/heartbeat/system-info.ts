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
  }
  pendingSyncCount?: number
  lastCloudSyncAt?: string | null
  /**
   * Most recent UDT_NETWORK_NODE_DATA snapshot per discovered device.
   * Populated when the poller has completed at least one cycle on a PLC
   * that has *_NetworkNode tags. Cloud receiver stores this inside the
   * systemInfo JSONB blob; no separate column.
   */
  networkDevices?: NetworkDeviceSnapshot[]
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
 * Build the full systemInfo blob for a heartbeat payload. Pure read-only.
 */
export function collectSystemInfo(): HeartbeatSystemInfo {
  const cpus = os.cpus()
  const cpuModel = cpus[0]?.model ?? 'unknown'
  const cpuCores = cpus.length

  const disk = collectDisk()
  const dbSizeMb = collectDbSizeMb()
  const networkDevices = collectNetworkDevices()

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

function collectNetworkDevices(): NetworkDeviceSnapshot[] {
  const now = Date.now()
  if (now - lastNetworkDevicesAttachedAt < NETWORK_DEVICES_HEARTBEAT_INTERVAL_MS) {
    return []
  }
  // Best-effort: never let a poller crash break the heartbeat.
  try {
    const snapshots = getLatestNetworkDeviceSnapshots()
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
