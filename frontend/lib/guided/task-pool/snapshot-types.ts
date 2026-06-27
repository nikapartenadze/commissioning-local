/**
 * DataSnapshot — the decoupled input to the (pure) task-pool builder.
 *
 * `snapshot.ts` reads SQLite + live PLC state and produces one of these.
 * `task-builder.ts` consumes ONLY this — never the DB — so the whole
 * prioritisation engine is unit-testable without a database or a PLC.
 */

export interface SnapshotIo {
  id: number
  name: string
  description: string | null
  result: 'Passed' | 'Failed' | null
  tagType: string | null
  /** True for outputs (`:O.`, `:SO.`, solenoids, …). */
  isOutput: boolean
  /** True for safety I/O (safety output, e-stop input, STO/BSD tag, …). */
  isSafety: boolean
  /**
   * Circuit type for the D6 pre-check / round-trip sequencing. NC devices
   * (photoeyes, EPCs, pull cords) rest TRUE; NO devices rest FALSE.
   */
  circuit: 'NC' | 'NO'
  /** Live PLC state from the tag cache, `null` when unknown / no PLC. */
  liveState: 'TRUE' | 'FALSE' | null
}

export interface SnapshotDevice {
  deviceName: string
  /** SVG document order, used for stable sequencing. */
  order: number
  ios: SnapshotIo[]
  /** Any of the device's IOs is a safety point. */
  isSafety: boolean
  /**
   * Installation is complete for this device. True when every matched IO has
   * InstallationStatus === 'complete' (or InstallationPercent >= 1). When the
   * cloud has synced NO install data for the device, this is `null` (unknown)
   * and the builder treats it as non-blocking.
   */
  installComplete: boolean | null
  /**
   * Device is networked + communicating. `null` when unknown (no live PLC).
   * Treated as non-blocking when unknown.
   */
  networked: boolean | null
}

export interface SnapshotEpc {
  name: string
  checkTag: string
  /** PRELIMINARY (zone-stop / positive) check result. */
  result: 'pass' | 'fail' | null
  /** FINAL (selectivity / negative) check result. Dual-safety verification. */
  finalResult: 'pass' | 'fail' | null
}

export interface SnapshotEstopZone {
  zoneName: string
  epcs: SnapshotEpc[]
  /**
   * Device names (matching SVG ids / io-check task devices) that belong to
   * this zone — derived from the zone's EPC VFD/IO/related tags. The zone's
   * E-Stop Verification gates on THESE devices' safety IO checks being done.
   * Empty when no device could be mapped (then the builder falls back to the
   * global "all safety IO done" rule).
   */
  safetyDeviceNames: string[]
}

export interface SnapshotVfdStep {
  name: string
  value: string | null
}

export interface SnapshotVfd {
  deviceName: string
  order: number
  steps: SnapshotVfdStep[]
  controlsVerified: boolean
}

export interface SnapshotFunctional {
  sheetName: string
  displayName: string
  deviceName: string
  order: number
  completedChecks: number
  totalChecks: number
}

/**
 * Firmware-compliance state for the guided firmware-check gate, summarised from
 * the last on-demand scan (GET /api/firmware). Optional on the snapshot: when
 * absent, no firmware task is generated (e.g. firmware checking not applicable).
 */
export interface SnapshotFirmware {
  /** A firmware scan has run this session (a cached scan exists). */
  scanned: boolean
  /** Devices read in the last scan (controller + networked). */
  deviceCount: number
  /** Devices below their approved minimum revision. */
  nonCompliantCount: number
  /** Devices read but with no matching baseline entry (unknown hardware). */
  noBaselineCount: number
}

export interface SnapshotNetwork {
  /** Network rings exist for this subsystem (there is a loop to verify). */
  hasRings: boolean
  /**
   * All DPMs marked 100% installed. `null` when unknown — treated as
   * non-blocking (don't keep the whole pool empty on missing install data).
   */
  dpmsAllInstalled: boolean | null
}

/** Manual status the tester applied to a task (skip / manual-complete). */
export interface ManualTaskStatus {
  status: 'skipped' | 'completed'
  reason?: string
}

export interface DataSnapshot {
  subsystemId: number
  mcm: string | null
  /**
   * Where the device-map SVG came from. 'mcm-diagram' = the real per-MCM
   * diagram (McmDiagrams); 'bundled-fallback' = the generic shipped SVG (its
   * ids likely DON'T match this MCM's I/O → few/no devices resolve); 'none' =
   * no SVG at all. Drives the readiness diagnostics in the builder.
   */
  mapSource: 'mcm-diagram' | 'bundled-fallback' | 'none'
  /** Live PLC tag data was flowing when the snapshot was taken. */
  plcConnected: boolean
  /**
   * Count of non-spare I/O rows for this subsystem (before map matching). Lets
   * the builder tell "map doesn't match this MCM" (ioCount > 0 but 0 devices
   * resolved) apart from "subsystem genuinely has no I/O" (ioCount === 0).
   */
  ioCount: number
  devices: SnapshotDevice[]
  estopZones: SnapshotEstopZone[]
  vfds: SnapshotVfd[]
  functional: SnapshotFunctional[]
  network: SnapshotNetwork
  /**
   * Firmware-compliance summary for the guided firmware-check gate. Optional —
   * absent means no firmware task is generated for this subsystem.
   */
  firmware?: SnapshotFirmware
  /** All "Belt Tracked" functional cells pass. `null` when no VFD/belt data. */
  beltsTracked: boolean | null
  /** All networked items communicating. `null` when unknown (no live PLC). */
  allNetworkedCommunicating: boolean | null
  /**
   * System started / conveyors running, derived from run-indicating PLC tags
   * (committee D4). `null` when no run tag is visible — non-blocking.
   */
  systemRunning: boolean | null
  /**
   * DLR ring health from the network poller (committee D5: guided mode cannot
   * function when the DPM ring is not nominal). 'unknown'/`null` never blocks
   * — only a confirmed 'degraded' ring gates the pool.
   */
  ringHealth: 'healthy' | 'degraded' | 'unknown' | null
  /** Keyed by Task.id → manual status the tester applied. */
  manualTaskStatus: Record<string, ManualTaskStatus>
}
