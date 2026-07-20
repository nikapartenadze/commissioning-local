import { describe, it, expect } from 'vitest'
import {
  DLR_NETWORK_STATUS,
  parseBreakNode,
  decodeDlrAoi,
  dlrTagNames,
  deriveAoiBase,
  type DlrAoiReading,
} from '@/lib/plc/network/dlr-aoi'

/** A healthy reading: PLC zero-fills both break arrays every scan. */
const healthy: DlrAoiReading = {
  breakPresent: 0,
  communicationFaulted: false,
  point1: new Array(10).fill(0),
  point2: new Array(10).fill(0),
}

const NODE_A = [192, 168, 5, 10, 0x00, 0x1d, 0x9c, 0x11, 0x22, 0x33]
const NODE_B = [192, 168, 5, 11, 0x00, 0x1d, 0x9c, 0x11, 0x22, 0x34]

describe('parseBreakNode', () => {
  it('decodes bytes 0-3 as IPv4 and bytes 4-9 as a lowercase colon MAC', () => {
    expect(parseBreakNode(NODE_A)).toEqual({ ip: '192.168.5.10', mac: '00:1d:9c:11:22:33' })
  })

  it('zero-pads single-hex-digit MAC octets', () => {
    expect(parseBreakNode([10, 0, 0, 1, 0x00, 0x0a, 0x0b, 0x00, 0x05, 0x0f]).mac)
      .toBe('00:0a:0b:00:05:0f')
  })

  it('returns nulls for an all-zero array (healthy / never populated, not "unknown node")', () => {
    expect(parseBreakNode(new Array(10).fill(0))).toEqual({ ip: null, mac: null })
  })

  it('returns nulls for a short array', () => {
    expect(parseBreakNode([192, 168, 5, 10])).toEqual({ ip: null, mac: null })
    expect(parseBreakNode([])).toEqual({ ip: null, mac: null })
    expect(parseBreakNode(new Array(9).fill(1))).toEqual({ ip: null, mac: null })
  })

  it('normalises signed SINT bytes to unsigned 0-255', () => {
    // -1 -> 255, -56 -> 200, -128 -> 128
    const signed = [-1, -56, -128, 1, -1, -1, -1, -1, -1, -1]
    expect(parseBreakNode(signed)).toEqual({ ip: '255.200.128.1', mac: 'ff:ff:ff:ff:ff:ff' })
  })

  it('normalises a signed MAC octet like -56 to 0xc8', () => {
    expect(parseBreakNode([10, 0, 0, 1, -56, 0, 0, 0, 0, 0]).mac).toBe('c8:00:00:00:00:00')
  })

  it('treats an all-zero array as empty even when the zeros arrive as -0/negative zero', () => {
    expect(parseBreakNode([0, -0, 0, -0, 0, 0, 0, 0, 0, 0])).toEqual({ ip: null, mac: null })
  })
})

describe('decodeDlrAoi', () => {
  it('reports healthy on status 0', () => {
    const v = decodeDlrAoi(healthy)
    expect(v.state).toBe('healthy')
    expect(v.reason).toBe('Ring closed (Normal)')
    expect(v.statusCode).toBe(0)
    expect(v.statusLabel).toBe('Normal')
    expect(v.breakBetween).toBeNull()
  })

  it('gives comms fault its own state and lets it beat a broken status', () => {
    const v = decodeDlrAoi({ ...healthy, communicationFaulted: true, breakPresent: 1 })
    expect(v.state).toBe('comm-fault')
    expect(v.state).not.toBe('broken')
    expect(v.reason).toMatch(/not communicating/i)
    expect(v.reason).toMatch(/ring state cannot be judged/i)
    expect(v.statusCode).toBeNull()
    expect(v.breakBetween).toBeNull()
  })

  it('reports unknown (not healthy) when the status tag could not be read', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: null })
    expect(v.state).toBe('unknown')
    expect(v.reason).toMatch(/could not be read/i)
    expect(v.statusCode).toBeNull()
    expect(v.statusLabel).toBeNull()
  })

  it('reports broken with the enum label for status 1 (Ring Fault)', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: 1 })
    expect(v.state).toBe('broken')
    expect(v.reason).toBe('Ring Fault')
    expect(v.statusLabel).toBe('Ring Fault')
    expect(v.statusCode).toBe(1)
  })

  it('reports broken for status 3 (Partial Network Fault)', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: 3 })
    expect(v.state).toBe('broken')
    expect(v.reason).toBe('Partial Network Fault')
  })

  // The PLC's own DLR_Broken flag only tests bit 0 of the status byte, so it
  // reports status 2 and 4 as HEALTHY. These two assertions are the whole point
  // of this module — we must be strictly more correct than that flag.
  it('reports status 2 (Unexpected Loop Detected) as broken — the PLC bit-0 flag misses this', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: 2 })
    expect(v.state).toBe('broken')
    expect(v.reason).toBe('Unexpected Loop Detected')
    expect(v.statusCode).toBe(2)
    expect((v.statusCode ?? 0) & 1).toBe(0) // bit 0 clear: the PLC flag would say "fine"
  })

  it('reports status 4 (Rapid Fault/Restore Cycle) as broken — the PLC bit-0 flag misses this', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: 4 })
    expect(v.state).toBe('broken')
    expect(v.reason).toBe('Rapid Fault/Restore Cycle')
    expect(v.statusCode).toBe(4)
    expect((v.statusCode ?? 0) & 1).toBe(0)
  })

  it('covers every label in the enumeration', () => {
    expect(DLR_NETWORK_STATUS).toHaveLength(5)
    for (let s = 1; s < DLR_NETWORK_STATUS.length; s++) {
      const v = decodeDlrAoi({ ...healthy, breakPresent: s })
      expect(v.state).toBe('broken')
      expect(v.reason).toBe(DLR_NETWORK_STATUS[s])
    }
  })

  it('reports an out-of-enumeration status as broken with the unknown-status reason', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: 9 })
    expect(v.state).toBe('broken')
    expect(v.reason).toBe('Unknown DLR status 9')
    expect(v.statusCode).toBe(9)
    expect(v.statusLabel).toBeNull()
  })

  it('populates breakBetween from both break points when the PLC localized the break', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: 1, point1: NODE_A, point2: NODE_B })
    expect(v.state).toBe('broken')
    expect(v.breakBetween).toEqual([
      { ip: '192.168.5.10', mac: '00:1d:9c:11:22:33' },
      { ip: '192.168.5.11', mac: '00:1d:9c:11:22:34' },
    ])
  })

  it('populates breakBetween when only one side has data (other side stays null)', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: 1, point1: NODE_A })
    expect(v.breakBetween).toEqual([
      { ip: '192.168.5.10', mac: '00:1d:9c:11:22:33' },
      { ip: null, mac: null },
    ])
  })

  it('leaves breakBetween null when both break points are all-zero', () => {
    const v = decodeDlrAoi({ ...healthy, breakPresent: 1 })
    expect(v.breakBetween).toBeNull()
  })

  it('leaves breakBetween null on an unknown status with no point data', () => {
    expect(decodeDlrAoi({ ...healthy, breakPresent: 9 }).breakBetween).toBeNull()
  })

  it('normalises a signed status byte before interpreting it', () => {
    // SINT -1 on the wire is 255 unsigned — out of enumeration, still broken.
    const v = decodeDlrAoi({ ...healthy, breakPresent: -1 })
    expect(v.state).toBe('broken')
    expect(v.statusCode).toBe(255)
    expect(v.reason).toBe('Unknown DLR status 255')
  })
})

describe('dlrTagNames', () => {
  it('builds the four fully-qualified tag paths, arrays with a [0] element suffix', () => {
    expect(dlrTagNames('MCM08_SLOT2_EN4TR')).toEqual({
      breakPresent: 'MCM08_SLOT2_EN4TR.AOI.DLR_Break_Present',
      commFaulted: 'MCM08_SLOT2_EN4TR.AOI.Communication_Faulted',
      point1: 'MCM08_SLOT2_EN4TR.HMI.DLR_Break_Point1_Data[0]',
      point2: 'MCM08_SLOT2_EN4TR.HMI.DLR_Break_Point2_Data[0]',
    })
  })
})

describe('deriveAoiBase', () => {
  it('finds a SLOTn_EN4TR device and qualifies it with the MCM name', () => {
    expect(deriveAoiBase(['SLOT2_EN4TR', 'SLOT0_L8'], 'MCM08')).toBe('MCM08_SLOT2_EN4TR')
  })

  it('matches names with a prefix and a suffix around the SLOTn_ENxTR token', () => {
    expect(deriveAoiBase(['UL27_10_VFD_NN', 'SLOT2_EN4TR_NN'], 'MCM08')).toBe('MCM08_SLOT2_EN4TR')
  })

  it('preserves the EN2TR distinction rather than assuming EN4TR', () => {
    expect(deriveAoiBase(['SLOT3_EN2TR'], 'MCM11')).toBe('MCM11_SLOT3_EN2TR')
  })

  it('returns null when no rack Ethernet module is present', () => {
    expect(deriveAoiBase(['UL27_10_VFD_NN', 'SLOT0_L8'], 'MCM08')).toBeNull()
    expect(deriveAoiBase([], 'MCM08')).toBeNull()
  })
})
