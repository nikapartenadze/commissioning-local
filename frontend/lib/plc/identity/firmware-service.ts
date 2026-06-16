/**
 * Firmware scan orchestrator.
 *
 * Ties together device discovery, the @raw Identity reader, the cached cloud
 * baseline, and the compliance evaluator into a single on-demand scan. Not
 * continuous — Identity reads are one-shot CIP requests, and a blind slot scan
 * would steal CIP slots from the IO tag reader if run on a timer. The "Scan"
 * button (POST /api/firmware/scan) drives it; the last result is cached for
 * GET /api/firmware.
 *
 * Reads are issued SEQUENTIALLY to keep CIP load low (the controller is already
 * being hammered by the IO poller). Anonymous blind-slot probes use a shorter
 * timeout and, when they don't answer, are dropped from the result so the view
 * isn't littered with empty-slot "unreachable" rows. Named targets that fail
 * are kept (a missing expected module is worth surfacing).
 *
 * Pure helpers it composes are unit-tested; this IO orchestrator is verified
 * against live hardware (see identity-reader.ts).
 */

import { getPlcStatus, getLatestNetworkDeviceSnapshots } from '@/lib/plc-client-manager'
import { configService } from '@/lib/config/config-service'
import { buildProbeList } from './device-discovery'
import { readIdentity, IDENTITY_READ_TIMEOUT_MS } from './identity-reader'
import { getCachedBaselines, getLastBaselineSyncAt } from '@/lib/cloud/firmware-baseline-sync'
import { findBaseline, evaluateCompliance, type ComplianceVerdict, type FirmwareBaseline } from './compliance'
import type { DeviceIdentity } from './identity-parse'

/** Shorter timeout for speculative blind-slot probes (empty slots just time out). */
const SLOT_PROBE_TIMEOUT_MS = 800

export interface FirmwareDeviceResult {
  label: string
  path: string
  /** Friendly model — the device's own Product Name, else the baseline's. */
  modelName: string | null
  /** "major.minor" live firmware, or null when unreachable. */
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
  /** False when no baseline has ever synced — verdicts are then all no_baseline. */
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
  path: string,
  identity: DeviceIdentity | null,
  baseline: FirmwareBaseline | undefined,
): FirmwareDeviceResult {
  return {
    label,
    path,
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
 * Run a full firmware scan: discover reachable CIP nodes, read each one's
 * Identity, and judge it against the cached baseline. Returns (and caches) the
 * result. When the PLC isn't connected, returns a connected:false result with
 * no devices rather than throwing.
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

  const gateway = status.connectionConfig.ip
  const controllerPath = status.connectionConfig.path
  const discoveredDeviceNames = getLatestNetworkDeviceSnapshots().map((s) => s.deviceName)
  const cfg = await configService.getConfig()

  const targets = buildProbeList({
    controllerPath,
    discoveredDeviceNames,
    dlrSupervisorPath: cfg.dlrSupervisorPath,
  })

  const devices: FirmwareDeviceResult[] = []
  for (const t of targets) {
    const isBlindSlot = t.label.startsWith('Slot ')
    const timeout = isBlindSlot ? SLOT_PROBE_TIMEOUT_MS : IDENTITY_READ_TIMEOUT_MS
    const identity = await readIdentity(gateway, t.path, timeout)

    // Drop anonymous empty-slot probes that didn't answer — they're noise.
    if (!identity && isBlindSlot) continue

    const baseline = identity ? findBaseline(baselines, identity.vendorId, identity.productCode) : undefined
    devices.push(toResult(t.label, t.path, identity, baseline))
  }

  lastScan = { ...base, connected: true, devices }
  return lastScan
}
