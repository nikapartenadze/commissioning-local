/**
 * Computed visual state for a device on the guided map.
 * Derived from per-IO test results plus the session's skipped list.
 */
export type DeviceState =
  | 'untested'      // no IOs tested yet, not skipped
  | 'in_progress'   // some IOs tested, some untested
  | 'passed'        // all IOs tested, all passed
  | 'failed'        // all IOs tested, at least one failed
  | 'skipped'       // session moved on without finishing
  | 'no_ios'        // device exists in SVG but has no IO rows in DB

export interface IoSummary {
  id: number
  name: string
  description: string | null
  result: 'Passed' | 'Failed' | null
  comments: string | null
  ioDirection: 'input' | 'output' | 'analog_input' | 'analog_output' | null
  /**
   * Installed-progress, 0..1. `null` if the cloud hasn't synced an
   * installation-tracker value for this IO yet. The regular grid renders
   * "Installed" at 1.0 and "<floor(pct*100)>%" otherwise — Guided mirrors
   * that. See enhanced-io-data-grid.tsx:1358-1362.
   */
  installationPercent: number | null
  /** Raw installation-tracker status (e.g. 'complete'). Used by the Pass gate. */
  installationStatus: string | null
}

export interface Device {
  /** Matches the `<g id>` in the SVG and `Ios.NetworkDeviceName` in DB. */
  deviceName: string
  /** Position in SVG document order (0-indexed). Used for "next" sequence. */
  order: number
  /** Counts derived from the Ios table for this device. */
  totalIos: number
  passedIos: number
  failedIos: number
  untestedIos: number
  state: DeviceState
}

export interface DeviceWithIos extends Device {
  ios: IoSummary[]
}
