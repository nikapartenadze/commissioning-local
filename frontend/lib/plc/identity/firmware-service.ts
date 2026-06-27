/**
 * Firmware scan orchestrator (diagnostics-first).
 *
 * Firmware is ALREADY harvested by the network diagnostics poller: the PLC
 * ladder MSG-populates each device's UDT_NETWORK_NODE_DATA header with
 * Product_Code + Firmware_Major/Minor (CIP Identity Class 0x01 Attr 3/4), and
 * getLatestNetworkDeviceSnapshots() exposes it. So for every networked device
 * we read firmware from those snapshots with ZERO extra CIP load — no per-device
 * probing, no blind slot scan.
 *
 * The one device the diagnostics poller does NOT cover is the controller itself
 * (it's not a network node). For that we do a single @raw CIP Identity read,
 * which also gives the controller's full vendor/serial/product-name that the UDT
 * doesn't carry.
 *
 * Caveats handled here:
 *   - The UDT header is 0/0/0 until the ladder runs its Identity MSG → treat as
 *     "not yet read" (unreachable), not a real 0.0 revision.
 *   - The UDT carries productCode but NO vendorId, so baseline matching is by
 *     productCode (findBaseline with vendorId = null). The controller @raw read
 *     has a real vendorId and matches exactly.
 *
 * On-demand: POST /api/firmware/scan; last result cached for GET /api/firmware.
 */

import { getPlcStatus, getLatestNetworkDeviceSnapshots } from '@/lib/plc-client-manager'
import { hasAnyMcm, getAllNetworkSnapshots, listMcms } from '@/lib/mcm-registry'
import { readIdentity } from './identity-reader'
import { getCachedBaselines, getLastBaselineSyncAt } from '@/lib/cloud/firmware-baseline-sync'
import { findBaseline, evaluateCompliance, type ComplianceVerdict, type FirmwareBaseline } from './compliance'
import type { DeviceIdentity } from './identity-parse'

export interface FirmwareDeviceResult {
  label: string
  /** Source identifier — controller routing path, or the diagnostics tag name. */
  source: string
  /** Friendly model — the device's own Product Name (@raw), else the baseline's. */
  modelName: string | null
  /** "major.minor" live firmware, or null when unreachable / not yet populated. */
  liveRevision: string | null
  /** "major.minor" approved minimum, or null when no baseline entry. */
  approvedMin: string | null
  vendorId: number | null
  productCode: number | null
  serial: number | null
  verdict: ComplianceVerdict
  /**
   * Owning MCM. Present on central-server (multi-MCM) results so each device /
   * controller can be attributed to its subsystem; undefined on legacy
   * single-MCM (tablet) results, which carry no subsystem context.
   */
  subsystemId?: string
}

export interface FirmwareScanResult {
  scannedAt: number
  connected: boolean
  baselineAvailable: boolean
  baselineSyncedAt: number | null
  devices: FirmwareDeviceResult[]
  /**
   * Per-MCM controller identities on a central server (one entry per connected
   * MCM, tagged with subsystemId). Omitted on single-MCM tablets, where the
   * sole controller is the first entry of `devices` exactly as before.
   */
  controllers?: FirmwareDeviceResult[]
  error?: string
}

let lastScan: FirmwareScanResult | null = null

/** The most recent scan result, or null if none has run this session. */
export function getLastFirmwareScan(): FirmwareScanResult | null {
  return lastScan
}

const rev = (major: number, minor: number) => `${major}.${minor}`

function toResult(
  label: string,
  source: string,
  identity: DeviceIdentity | null,
  baseline: FirmwareBaseline | undefined,
  subsystemId?: string,
): FirmwareDeviceResult {
  return {
    label,
    source,
    modelName: identity?.productName || baseline?.modelName || null,
    liveRevision: identity ? rev(identity.revMajor, identity.revMinor) : null,
    approvedMin: baseline ? rev(baseline.minRevMajor, baseline.minRevMinor) : null,
    vendorId: identity?.vendorId ?? null,
    productCode: identity?.productCode ?? null,
    serial: identity?.serial ?? null,
    verdict: evaluateCompliance(identity, baseline),
    ...(subsystemId !== undefined ? { subsystemId } : {}),
  }
}

/**
 * Build a synthetic DeviceIdentity from a diagnostics snapshot, or null when the
 * UDT header hasn't been populated yet (all-zero). vendorId is left at 0 — it's
 * unknown from diagnostics and unused in matching (we match by productCode).
 */
function identityFromSnapshot(
  productCode: number, firmwareMajor: number, firmwareMinor: number,
): DeviceIdentity | null {
  if (productCode === 0 && firmwareMajor === 0 && firmwareMinor === 0) return null
  return {
    vendorId: 0,
    deviceType: 0,
    productCode,
    revMajor: firmwareMajor,
    revMinor: firmwareMinor,
    status: 0,
    serial: 0,
    productName: '',
  }
}

/**
 * Read EVERY connected controller's firmware (one @raw Identity request each)
 * and judge each against the cached baseline. The controller is not a network
 * node, so it's absent from the diagnostics snapshots the view already renders.
 *
 * Multi-MCM aware (mirrors the device-snapshot split in scanFirmware): on a
 * central server the singleton getPlcStatus() collapses to the FIRST connected
 * MCM only, hiding every other controller's firmware. When the registry is in
 * use we iterate its connected MCMs and read each controller, tagging the
 * result with its subsystemId. Legacy single-MCM tablets keep the singleton
 * path (one untagged controller).
 */
export async function scanControllers(): Promise<FirmwareDeviceResult[]> {
  const baselines = getCachedBaselines()

  if (hasAnyMcm()) {
    const connected = listMcms().filter((m) => m.connected)
    const results = await Promise.all(
      connected.map(async (mcm) => {
        const ctrl = await readIdentity(mcm.ip, mcm.path)
        const baseline = ctrl ? findBaseline(baselines, ctrl.vendorId, ctrl.productCode) : undefined
        const label = mcm.name ? `Controller (${mcm.name})` : `Controller (MCM ${mcm.subsystemId})`
        return toResult(label, mcm.path, ctrl, baseline, mcm.subsystemId)
      }),
    )
    return results
  }

  // Singleton (tablet) path — unchanged.
  const status = getPlcStatus()
  if (!status.connected || !status.connectionConfig) return []
  const ctrl = await readIdentity(status.connectionConfig.ip, status.connectionConfig.path)
  const baseline = ctrl ? findBaseline(baselines, ctrl.vendorId, ctrl.productCode) : undefined
  return [toResult('Controller', status.connectionConfig.path, ctrl, baseline)]
}

/**
 * Read ONLY a controller's firmware. Back-compat single-result wrapper for the
 * diagnostics view's controller card. Returns the sole controller on a tablet,
 * or the first connected MCM's controller on a central server (use
 * scanControllers() to enumerate all). Null when nothing is connected.
 */
export async function scanController(): Promise<FirmwareDeviceResult | null> {
  const controllers = await scanControllers()
  return controllers[0] ?? null
}

/**
 * Snapshot-shaped controller Identity, folded into the network-diagnostics push
 * so the cloud's fleet firmware compliance can see the PLC itself (it's not a
 * network node, so it's otherwise invisible to the cloud). Mirrors the device
 * snapshot fields the cloud reads, plus `isController` so the per-port topology
 * view filters it out (it has no ports). `subsystemId` present on central.
 */
export interface ControllerPushSnapshot {
  tagName: string
  deviceName: string
  productCode: number
  firmwareMajor: number
  firmwareMinor: number
  capturedAt: number
  isController: true
  ports: never[]
  subsystemId?: string
}

// Controller firmware is static for the life of a connection, so cache the
// Identity per (ip|path) and reuse it on every 60s push — the diagnostics push
// must not add a recurring @raw CIP read. Keyed by ip+path so a central server
// caches each MCM's controller independently. Cleared implicitly on restart.
const controllerIdentityCache = new Map<string, DeviceIdentity>()

async function readControllerIdentityCached(ip: string, path: string): Promise<DeviceIdentity | null> {
  const key = `${ip}|${path}`
  const cached = controllerIdentityCache.get(key)
  if (cached) return cached
  const identity = await readIdentity(ip, path)
  if (identity) controllerIdentityCache.set(key, identity)
  return identity
}

/**
 * Build controller push-snapshots for every connected controller (one cached
 * @raw Identity read per controller, then free). Central-aware: enumerates each
 * connected MCM and tags its subsystemId; single-MCM tablets return the sole
 * controller untagged. Empty when nothing is connected / Identity unreadable.
 */
export async function getControllerPushSnapshots(): Promise<ControllerPushSnapshot[]> {
  const now = Date.now()
  const build = (identity: DeviceIdentity, deviceName: string, tagName: string, subsystemId?: string): ControllerPushSnapshot => ({
    tagName,
    deviceName,
    productCode: identity.productCode,
    firmwareMajor: identity.revMajor,
    firmwareMinor: identity.revMinor,
    capturedAt: now,
    isController: true,
    ports: [],
    ...(subsystemId !== undefined ? { subsystemId } : {}),
  })

  if (hasAnyMcm()) {
    const out: ControllerPushSnapshot[] = []
    for (const mcm of listMcms().filter((m) => m.connected)) {
      const identity = await readControllerIdentityCached(mcm.ip, mcm.path)
      if (!identity) continue
      const label = mcm.name ? `Controller (${mcm.name})` : `Controller (MCM ${mcm.subsystemId})`
      out.push(build(identity, label, mcm.path, mcm.subsystemId))
    }
    return out
  }

  const status = getPlcStatus()
  if (!status.connected || !status.connectionConfig) return []
  const identity = await readControllerIdentityCached(status.connectionConfig.ip, status.connectionConfig.path)
  if (!identity) return []
  return [build(identity, 'Controller', status.connectionConfig.path)]
}

/**
 * Run a firmware scan: read the controller's Identity (@raw, one request) and
 * fold in the firmware the diagnostics poller has already captured for every
 * networked device. Judge each against the cached baseline. Returns (and caches)
 * the result; returns connected:false with no devices when the PLC is offline.
 */
export async function scanFirmware(): Promise<FirmwareScanResult> {
  const status = getPlcStatus()
  const baselines = getCachedBaselines()
  const base = {
    scannedAt: Date.now(),
    baselineAvailable: baselines.length > 0,
    baselineSyncedAt: getLastBaselineSyncAt(),
  }

  const central = hasAnyMcm()

  // On a central server "connected" means at least one MCM is connected; on a
  // tablet it's the singleton's status. (baselines is read above.)
  const singletonConnected = status.connected && !!status.connectionConfig

  // Controllers — not network nodes; one @raw Identity read each. Multi-MCM
  // aware: scanControllers() iterates EVERY connected MCM on a central server
  // (the singleton getPlcStatus() would otherwise collapse to MCM #1 only).
  const controllers = await scanControllers()

  if (!central && !singletonConnected) {
    lastScan = { ...base, connected: false, devices: [], error: 'PLC not connected' }
    return lastScan
  }
  if (central && controllers.length === 0) {
    lastScan = { ...base, connected: false, devices: [], error: 'No MCM connected' }
    return lastScan
  }

  const devices: FirmwareDeviceResult[] = []

  // Keep the controller(s) as the leading device entries (single-MCM callers
  // read devices[0] as "the controller" exactly as before).
  devices.push(...controllers)

  // Networked devices — firmware already in the diagnostics snapshots.
  // Multi-MCM aware: a central server (PLC_MODE=remote) has no singleton
  // poller, so getLatestNetworkDeviceSnapshots() (singleton-only) would hide
  // EVERY networked device's firmware — defeating "expose firmware of ALL
  // hardware" on exactly the deployment that hosts the most devices. Prefer the
  // registry's aggregate snapshots (REMOTE-aware) when the registry is in use;
  // fall back to the singleton poller for legacy single-MCM tablets.
  const deviceSnapshots = central ? getAllNetworkSnapshots() : getLatestNetworkDeviceSnapshots()
  for (const snap of deviceSnapshots) {
    const identity = identityFromSnapshot(snap.productCode, snap.firmwareMajor, snap.firmwareMinor)
    // vendorId unknown from diagnostics → match baseline by productCode only.
    const baseline = identity ? findBaseline(baselines, null, identity.productCode) : undefined
    // Aggregate snapshots carry subsystemId; the singleton poller's do not.
    const sub = (snap as { subsystemId?: string }).subsystemId
    devices.push(toResult(snap.deviceName, snap.tagName, identity, baseline, sub))
  }

  // Surface the per-MCM controllers separately on a central server so callers
  // can attribute each controller to its subsystem. Single-MCM tablets keep the
  // old shape (sole controller is devices[0], no `controllers` array).
  lastScan = central
    ? { ...base, connected: true, devices, controllers }
    : { ...base, connected: true, devices }
  return lastScan
}
