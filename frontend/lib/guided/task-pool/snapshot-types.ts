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
  result: 'pass' | 'fail' | null
}

export interface SnapshotEstopZone {
  zoneName: string
  epcs: SnapshotEpc[]
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
  devices: SnapshotDevice[]
  estopZones: SnapshotEstopZone[]
  vfds: SnapshotVfd[]
  functional: SnapshotFunctional[]
  network: SnapshotNetwork
  /** All "Belt Tracked" functional cells pass. `null` when no VFD/belt data. */
  beltsTracked: boolean | null
  /** All networked items communicating. `null` when unknown (no live PLC). */
  allNetworkedCommunicating: boolean | null
  /** Keyed by Task.id → manual status the tester applied. */
  manualTaskStatus: Record<string, ManualTaskStatus>
}
