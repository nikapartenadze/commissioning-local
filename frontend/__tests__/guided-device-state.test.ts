import { describe, expect, it } from 'vitest'
import {
  computeDeviceState,
  findCurrentTarget,
} from '@/lib/guided/device-state'
import type { Device } from '@/lib/guided/types'

describe('computeDeviceState', () => {
  it('returns no_ios when device has zero IOs', () => {
    expect(
      computeDeviceState({ total: 0, passed: 0, failed: 0 }, false),
    ).toBe('no_ios')
  })

  it('returns untested when no IOs tested and not skipped', () => {
    expect(
      computeDeviceState({ total: 5, passed: 0, failed: 0 }, false),
    ).toBe('untested')
  })

  it('returns skipped when untested IOs remain and device is in skipped set', () => {
    expect(
      computeDeviceState({ total: 5, passed: 2, failed: 0 }, true),
    ).toBe('skipped')
  })

  it('returns in_progress when some tested and some untested and not skipped', () => {
    expect(
      computeDeviceState({ total: 5, passed: 2, failed: 0 }, false),
    ).toBe('in_progress')
    expect(
      computeDeviceState({ total: 5, passed: 0, failed: 1 }, false),
    ).toBe('in_progress')
  })

  it('returns passed when all IOs passed', () => {
    expect(
      computeDeviceState({ total: 3, passed: 3, failed: 0 }, false),
    ).toBe('passed')
  })

  it('returns failed when all IOs tested and at least one failed', () => {
    expect(
      computeDeviceState({ total: 3, passed: 2, failed: 1 }, false),
    ).toBe('failed')
  })

  it('passed takes precedence over skipped flag when nothing left untested', () => {
    expect(
      computeDeviceState({ total: 3, passed: 3, failed: 0 }, true),
    ).toBe('passed')
  })
})

describe('findCurrentTarget', () => {
  const make = (deviceName: string, order: number, state: Device['state']): Device => ({
    deviceName,
    order,
    totalIos: 1,
    passedIos: 0,
    failedIos: 0,
    untestedIos: 1,
    state,
  })

  it('picks first untested device by order', () => {
    const devices = [
      make('A', 0, 'passed'),
      make('B', 1, 'untested'),
      make('C', 2, 'untested'),
    ]
    expect(findCurrentTarget(devices)?.deviceName).toBe('B')
  })

  it('picks first in_progress when no untested remain before it', () => {
    const devices = [
      make('A', 0, 'passed'),
      make('B', 1, 'in_progress'),
      make('C', 2, 'untested'),
    ]
    expect(findCurrentTarget(devices)?.deviceName).toBe('B')
  })

  it('skips skipped and failed devices when picking next target', () => {
    const devices = [
      make('A', 0, 'failed'),
      make('B', 1, 'skipped'),
      make('C', 2, 'untested'),
    ]
    expect(findCurrentTarget(devices)?.deviceName).toBe('C')
  })

  it('returns null when every device is passed/failed/skipped/no_ios', () => {
    const devices = [
      make('A', 0, 'passed'),
      make('B', 1, 'failed'),
      make('C', 2, 'skipped'),
      make('D', 3, 'no_ios'),
    ]
    expect(findCurrentTarget(devices)).toBeNull()
  })
})
