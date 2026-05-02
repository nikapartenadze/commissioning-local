import type { Device, DeviceState } from './types'

interface Counts {
  total: number
  passed: number
  failed: number
}

/**
 * Derive a device's visual state from its IO test counts and whether the
 * current session has the device in its skipped set.
 */
export function computeDeviceState(counts: Counts, isSkipped: boolean): DeviceState {
  if (counts.total === 0) return 'no_ios'
  const tested = counts.passed + counts.failed
  const untested = counts.total - tested
  if (untested === 0) {
    return counts.failed > 0 ? 'failed' : 'passed'
  }
  if (isSkipped) return 'skipped'
  if (tested > 0) return 'in_progress'
  return 'untested'
}

/**
 * Pick the recommended next device for the operator: first device in SVG
 * document order whose state is `untested` or `in_progress`.
 *
 * Failed/skipped/no_ios devices are intentionally NOT auto-targeted — the
 * operator can still tap them if they want to retest, but the sequence
 * doesn't drag them back automatically.
 */
export function findCurrentTarget(devices: Device[]): Device | null {
  const sorted = [...devices].sort((a, b) => a.order - b.order)
  for (const d of sorted) {
    if (d.state === 'untested' || d.state === 'in_progress') return d
  }
  return null
}
