import { describe, it, expect } from 'vitest'
import { slotPathForDevice, buildProbeList } from '@/lib/plc/identity/device-discovery'

describe('slotPathForDevice', () => {
  it('derives a backplane path from a SLOTn_ENxTR device name', () => {
    expect(slotPathForDevice('SLOT2_EN4TR_NN')).toBe('1,2')
    expect(slotPathForDevice('MCM04_SLOT3_EN2TR')).toBe('1,3')
  })
  it('returns null for names that do not encode a slot', () => {
    expect(slotPathForDevice('UL27_10_VFD_NN')).toBeNull()
    expect(slotPathForDevice('')).toBeNull()
  })
})

describe('buildProbeList', () => {
  it('always probes the controller first, at its configured path', () => {
    const list = buildProbeList({ controllerPath: '1,0', backplaneSlotScan: null })
    expect(list[0]).toEqual({ label: 'Controller', path: '1,0' })
  })

  it('adds slot paths for discovered SLOTn_ENxTR devices, keeping the friendly label', () => {
    const list = buildProbeList({
      controllerPath: '1,0',
      discoveredDeviceNames: ['SLOT2_EN4TR_NN', 'UL27_10_VFD_NN'],
      backplaneSlotScan: null,
    })
    expect(list).toContainEqual({ label: 'SLOT2_EN4TR_NN', path: '1,2' })
    // VFD has no derivable path and no explicit target → not probed in phase 1
    expect(list.some((t) => t.label === 'UL27_10_VFD_NN')).toBe(false)
  })

  it('dedupes by routing path — a named device wins over a blind slot-scan entry', () => {
    const list = buildProbeList({
      controllerPath: '1,0',
      discoveredDeviceNames: ['SLOT2_EN4TR_NN'],
      backplaneSlotScan: { port: 1, maxSlot: 4 },
    })
    const atSlot2 = list.filter((t) => t.path === '1,2')
    expect(atSlot2).toHaveLength(1)
    expect(atSlot2[0].label).toBe('SLOT2_EN4TR_NN') // not "Slot 2"
  })

  it('includes the DLR supervisor path when provided', () => {
    const list = buildProbeList({ controllerPath: '1,0', dlrSupervisorPath: '1,5', backplaneSlotScan: null })
    expect(list).toContainEqual({ label: 'DLR supervisor', path: '1,5' })
  })

  it('merges explicit targets (the program-export seam) and dedupes them too', () => {
    const list = buildProbeList({
      controllerPath: '1,0',
      explicitTargets: [
        { label: 'NCP1 VFD', path: '1,2,A,192.168.1.50,1,0' },
        { label: 'dup ctrl', path: '1,0' }, // already present as Controller → dropped
      ],
      backplaneSlotScan: null,
    })
    expect(list).toContainEqual({ label: 'NCP1 VFD', path: '1,2,A,192.168.1.50,1,0' })
    expect(list.filter((t) => t.path === '1,0')).toHaveLength(1)
  })

  it('generates a blind backplane slot scan over the requested range', () => {
    const list = buildProbeList({ controllerPath: '2,0', backplaneSlotScan: { port: 2, maxSlot: 3 } })
    expect(list.map((t) => t.path)).toEqual(['2,0', '2,1', '2,2', '2,3'])
  })
})
