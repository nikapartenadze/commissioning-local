import { describe, it, expect } from 'vitest'
import { isDpmSwitch, summarizeDpmRing, type DpmDevice } from '@/lib/plc/network/dpm-ring'

const port = (over: Partial<DpmDevice['ports'][number]> = {}) => ({
  portNumber: 1, linkUp: true, hardwareFault: false, octetsIn: 1000, octetsOut: 1000, ...over,
})

describe('isDpmSwitch', () => {
  it('matches Hirschmann DPM switch names, not other devices', () => {
    expect(isDpmSwitch('UL29_8_DPM1')).toBe(true)
    expect(isDpmSwitch('UL29_13_DPM1_NN')).toBe(true)
    expect(isDpmSwitch('UL27_10_VFD')).toBe(false)
    expect(isDpmSwitch('SLOT2_EN4TR')).toBe(false)
  })
})

describe('summarizeDpmRing', () => {
  it('is unknown when no DPM switches are present', () => {
    const out = summarizeDpmRing([{ deviceName: 'UL27_10_VFD', ports: [port({ linkUp: false, octetsIn: 0, octetsOut: 0 })] }])
    expect(out.state).toBe('unknown')
    expect(out.switchCount).toBe(0)
  })

  it('is healthy when every DPM switch has its active ports up and no faults', () => {
    const out = summarizeDpmRing([
      { deviceName: 'UL29_8_DPM1', ports: [port({ portNumber: 1 }), port({ portNumber: 2 })] },
      { deviceName: 'UL29_13_DPM1', ports: [port({ portNumber: 1 })] },
    ])
    expect(out.state).toBe('healthy')
    expect(out.switchCount).toBe(2)
    expect(out.issues).toHaveLength(0)
  })

  it('flags a DPM switch with a port that carried traffic then went down (broken ring link)', () => {
    const out = summarizeDpmRing([
      { deviceName: 'UL29_8_DPM1', ports: [port({ portNumber: 2, linkUp: false, octetsIn: 5000, octetsOut: 4000 })] },
    ])
    expect(out.state).toBe('degraded')
    expect(out.issues[0].deviceName).toBe('UL29_8_DPM1')
    expect(out.issues[0].detail).toMatch(/port 2/)
  })

  it('flags a hardware fault on a DPM switch port', () => {
    const out = summarizeDpmRing([
      { deviceName: 'UL29_8_DPM2', ports: [port({ portNumber: 3, hardwareFault: true })] },
    ])
    expect(out.state).toBe('degraded')
    expect(out.issues[0].detail).toMatch(/fault/i)
  })

  it('ignores unused down ports (never carried traffic) — not a fault', () => {
    const out = summarizeDpmRing([
      { deviceName: 'UL29_8_DPM1', ports: [port({ portNumber: 1 }), port({ portNumber: 9, linkUp: false, octetsIn: 0, octetsOut: 0 })] },
    ])
    expect(out.state).toBe('healthy')
  })

  it('ignores non-DPM devices when judging the ring', () => {
    const out = summarizeDpmRing([
      { deviceName: 'UL29_8_DPM1', ports: [port({ portNumber: 1 })] },
      { deviceName: 'UL27_10_VFD', ports: [port({ portNumber: 1, linkUp: false, octetsIn: 9000, octetsOut: 0 })] },
    ])
    expect(out.state).toBe('healthy')
  })
})
