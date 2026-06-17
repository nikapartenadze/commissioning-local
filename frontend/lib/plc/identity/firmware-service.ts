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
import { hasAnyMcm, getAllNetworkSnapshots } from '@/lib/mcm-registry'
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
}

export interface FirmwareScanResult {
  scannedAt: number
  connected: boolean
  baselineAvailable: boolean
  baselineSyncedAt: number | null
  devices: FirmwareDeviceResult[]
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
 * Read ONLY the controller's firmware (single @raw Identity request) and judge
 * it against the cached baseline. Used by the diagnostics view's controller card
 * (the controller isn't a network node, so it's absent from the snapshots the
 * view already renders). Returns null when the PLC isn't connected.
 */
export async function scanController(): Promise<FirmwareDeviceResult | null> {
  const status = getPlcStatus()
  if (!status.connected || !status.connectionConfig) return null
  const baselines = getCachedBaselines()
  const ctrl = await readIdentity(status.connectionConfig.ip, status.connectionConfig.path)
  const baseline = ctrl ? findBaseline(baselines, ctrl.vendorId, ctrl.productCode) : undefined
  return toResult('Controller', status.connectionConfig.path, ctrl, baseline)
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

  if (!status.connected || !status.connectionConfig) {
    lastScan = { ...base, connected: false, devices: [], error: 'PLC not connected' }
    return lastScan
  }

  const devices: FirmwareDeviceResult[] = []

  // Controller — not a network node; single @raw Identity read (full identity).
  const ctrl = await readIdentity(status.connectionConfig.ip, status.connectionConfig.path)
  const ctrlBaseline = ctrl ? findBaseline(baselines, ctrl.vendorId, ctrl.productCode) : undefined
  devices.push(toResult('Controller', status.connectionConfig.path, ctrl, ctrlBaseline))

  // Networked devices — firmware already in the diagnostics snapshots.
  // Multi-MCM aware: a central server (PLC_MODE=remote) has no singleton
  // poller, so getLatestNetworkDeviceSnapshots() (singleton-only) would hide
  // EVERY networked device's firmware — defeating "expose firmware of ALL
  // hardware" on exactly the deployment that hosts the most devices. Prefer the
  // registry's aggregate snapshots (REMOTE-aware) when the registry is in use;
  // fall back to the singleton poller for legacy single-MCM tablets.
  const deviceSnapshots = hasAnyMcm() ? getAllNetworkSnapshots() : getLatestNetworkDeviceSnapshots()
  for (const snap of deviceSnapshots) {
    const identity = identityFromSnapshot(snap.productCode, snap.firmwareMajor, snap.firmwareMinor)
    // vendorId unknown from diagnostics → match baseline by productCode only.
    const baseline = identity ? findBaseline(baselines, null, identity.productCode) : undefined
    devices.push(toResult(snap.deviceName, snap.tagName, identity, baseline))
  }

  lastScan = { ...base, connected: true, devices }
  return lastScan
}
