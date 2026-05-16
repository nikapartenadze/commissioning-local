import type { RoadmapStep } from './roadmap-types'

type DeviceState = 'untested' | 'in_progress' | 'passed' | 'failed' | 'skipped' | 'no_ios'
type IoResult = 'Passed' | 'Failed' | null

export function shouldAdvanceStep(
  step: RoadmapStep,
  deviceState: DeviceState,
  ioResult: IoResult,
): boolean {
  if (step.kind === 'io') {
    return ioResult === 'Passed' || ioResult === 'Failed'
  }
  return deviceState === 'passed' || deviceState === 'failed'
}
