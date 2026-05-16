import { describe, expect, it } from 'vitest'
import { shouldAdvanceStep } from '@/lib/guided/roadmap-advance'
import type { RoadmapStep } from '@/lib/guided/roadmap-types'

const deviceStep: RoadmapStep = {
  order: 1, kind: 'device', deviceName: 'UL17_20_VFD',
  instructionText: 'Test the VFD',
}
const ioStep: RoadmapStep = {
  order: 1, kind: 'io', deviceName: 'EPC1_2', ioName: 'EPC1_2.CORD_PULL',
  instructionText: 'Pull the cord',
}

describe('shouldAdvanceStep', () => {
  describe('device-kind', () => {
    it('does NOT advance when device is untested', () => {
      expect(shouldAdvanceStep(deviceStep, 'untested', null)).toBe(false)
    })
    it('does NOT advance when device is in_progress', () => {
      expect(shouldAdvanceStep(deviceStep, 'in_progress', null)).toBe(false)
    })
    it('advances when device is passed', () => {
      expect(shouldAdvanceStep(deviceStep, 'passed', null)).toBe(true)
    })
    it('advances when device is failed', () => {
      expect(shouldAdvanceStep(deviceStep, 'failed', null)).toBe(true)
    })
    it('does NOT advance when no_ios (treat as untestable, operator must skip)', () => {
      expect(shouldAdvanceStep(deviceStep, 'no_ios', null)).toBe(false)
    })
  })

  describe('io-kind', () => {
    it('does NOT advance when target IO has no result', () => {
      expect(shouldAdvanceStep(ioStep, 'in_progress', null)).toBe(false)
    })
    it('advances when target IO is passed', () => {
      expect(shouldAdvanceStep(ioStep, 'in_progress', 'Passed')).toBe(true)
    })
    it('advances when target IO is failed', () => {
      expect(shouldAdvanceStep(ioStep, 'in_progress', 'Failed')).toBe(true)
    })
    it('does NOT advance regardless of device state when IO is untested', () => {
      expect(shouldAdvanceStep(ioStep, 'passed', null)).toBe(false)
    })
  })
})
