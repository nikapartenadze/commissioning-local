import { describe, expect, it } from 'vitest'
import { guidedReducer, initialGuidedState } from '@/lib/guided/use-guided-session'
import type { Device } from '@/lib/guided/types'

const dev = (deviceName: string, order: number): Device => ({
  deviceName,
  order,
  totalIos: 5,
  passedIos: 0,
  failedIos: 0,
  untestedIos: 5,
  state: 'untested',
})

describe('guidedReducer', () => {
  it('LOAD_DEVICES populates devices and clears loading', () => {
    const next = guidedReducer(
      { ...initialGuidedState, isLoading: true },
      { type: 'LOAD_DEVICES', devices: [dev('A', 0), dev('B', 1)] },
    )
    expect(next.devices.map(d => d.deviceName)).toEqual(['A', 'B'])
    expect(next.isLoading).toBe(false)
  })

  it('OPEN_DEVICE sets selectedDevice', () => {
    const next = guidedReducer(initialGuidedState, { type: 'OPEN_DEVICE', deviceName: 'A' })
    expect(next.selectedDevice).toBe('A')
  })

  it('CLOSE_DEVICE clears selectedDevice', () => {
    const next = guidedReducer(
      { ...initialGuidedState, selectedDevice: 'A' },
      { type: 'CLOSE_DEVICE' },
    )
    expect(next.selectedDevice).toBeNull()
  })

  it('SKIP_DEVICE adds to skipped set, closes drawer', () => {
    const next = guidedReducer(
      { ...initialGuidedState, selectedDevice: 'A' },
      { type: 'SKIP_DEVICE', deviceName: 'A' },
    )
    expect(next.skippedDevices.has('A')).toBe(true)
    expect(next.selectedDevice).toBeNull()
  })

  it('UNSKIP_DEVICE removes from skipped set', () => {
    const start = { ...initialGuidedState, skippedDevices: new Set(['A', 'B']) }
    const next = guidedReducer(start, { type: 'UNSKIP_DEVICE', deviceName: 'A' })
    expect(next.skippedDevices.has('A')).toBe(false)
    expect(next.skippedDevices.has('B')).toBe(true)
  })
})
