import { describe, it, expect } from 'vitest'
import {
  bufferReader,
  parsePort,
  parseNetworkDevice,
} from '@/lib/plc/network/parser'
import { NETWORK_NODE_LAYOUT } from '@/lib/plc/network/types'

/**
 * Build a fixture buffer for one UDT_NETWORK_NODE_DATA tag. Counters fan out
 * as monotonically increasing values so the parser can prove it's using the
 * right offsets — if anything is one slot off, the assertions will catch it.
 */
function fixtureBuffer(): Buffer {
  const buf = Buffer.alloc(NETWORK_NODE_LAYOUT.TOTAL_SIZE)
  // Header
  buf.writeInt16LE(0x1234, NETWORK_NODE_LAYOUT.HEADER.PRODUCT_CODE)
  buf.writeInt8(7, NETWORK_NODE_LAYOUT.HEADER.FIRMWARE_MAJOR)
  buf.writeInt8(1, NETWORK_NODE_LAYOUT.HEADER.FIRMWARE_MINOR)

  // For each port, write a flag byte and a stride of distinct DINTs so we
  // can detect off-by-one errors.
  for (let i = 0; i < NETWORK_NODE_LAYOUT.PORT_COUNT; i++) {
    const base = NETWORK_NODE_LAYOUT.PORTS_OFFSET + i * NETWORK_NODE_LAYOUT.PORT_SIZE

    // Pack flags: link up + full duplex on even-indexed ports, hardware fault on port 5
    let flags = 0
    if (i % 2 === 0) flags |= 0b0011
    if (i === 4) flags |= 0b1000
    buf.writeInt8(flags, base + NETWORK_NODE_LAYOUT.PORT.FLAGS)

    // Each DINT slot = (i + 1) * 1000 + (offset-of-field-within-port). Distinct per port AND per field.
    const P = NETWORK_NODE_LAYOUT.PORT
    const fields: [number, number][] = [
      [P.LINK_STATUS_RAW, 0xa5a5a5a5 | 0],
      [P.SPEED_MBPS, i === 0 ? 1000 : i === 1 ? 100 : 10],
      [P.OCTETS_IN, (i + 1) * 1_000_000],
      [P.UCAST_IN, (i + 1) * 10_000],
      [P.NUCAST_IN, (i + 1) * 10],
      [P.DISCARDS_IN, (i + 1) * 1],
      [P.ERRORS_IN, (i + 1) * 2],
      [P.UNKNOWN_PROTOS_IN, (i + 1) * 3],
      [P.OCTETS_OUT, (i + 1) * 2_000_000],
      [P.UCAST_OUT, (i + 1) * 20_000],
      [P.NUCAST_OUT, (i + 1) * 20],
      [P.DISCARDS_OUT, (i + 1) * 4],
      [P.ERRORS_OUT, (i + 1) * 5],
      [P.ALIGN_ERR, (i + 1) * 6],
      [P.FCS_ERR, (i + 1) * 7],
      [P.SINGLE_COLL, (i + 1) * 8],
      [P.MULTI_COLL, (i + 1) * 9],
      [P.SQE_ERR, (i + 1) * 11],
      [P.DEFERRED_TX, (i + 1) * 12],
      [P.LATE_COLL, (i + 1) * 13],
      [P.EXCESS_COLL, (i + 1) * 14],
      [P.MAC_TX_ERR, (i + 1) * 15],
      [P.CARRIER_SENSE, (i + 1) * 16],
      [P.FRAME_TOO_LONG, (i + 1) * 17],
      [P.MAC_RX_ERR, (i + 1) * 18],
    ]
    for (const [off, value] of fields) {
      buf.writeInt32LE(value, base + off)
    }
  }
  return buf
}

describe('NetworkDeviceSnapshot parser', () => {
  it('parses header fields', () => {
    const snap = parseNetworkDevice(bufferReader(fixtureBuffer()), {
      tagName: 'TEST_NetworkNode',
      deviceName: 'TEST',
      capturedAt: 1700000000000,
    })
    expect(snap.productCode).toBe(0x1234)
    expect(snap.firmwareMajor).toBe(7)
    expect(snap.firmwareMinor).toBe(1)
    expect(snap.ports).toHaveLength(32)
    expect(snap.tagName).toBe('TEST_NetworkNode')
    expect(snap.deviceName).toBe('TEST')
    expect(snap.capturedAt).toBe(1700000000000)
  })

  it('parses port flags correctly', () => {
    const snap = parseNetworkDevice(bufferReader(fixtureBuffer()), {
      tagName: 't',
      deviceName: 'd',
      capturedAt: 0,
    })
    // Even-indexed ports have linkUp + fullDuplex
    expect(snap.ports[0].linkUp).toBe(true)
    expect(snap.ports[0].fullDuplex).toBe(true)
    expect(snap.ports[0].hardwareFault).toBe(false)

    // Odd-indexed ports have no flags
    expect(snap.ports[1].linkUp).toBe(false)
    expect(snap.ports[1].fullDuplex).toBe(false)

    // Port index 4 (physical port 5) has hardwareFault
    expect(snap.ports[4].hardwareFault).toBe(true)
    expect(snap.ports[4].linkUp).toBe(true)

    // Port numbers are 1-indexed
    expect(snap.ports[0].portNumber).toBe(1)
    expect(snap.ports[31].portNumber).toBe(32)
  })

  it('parses port counters using distinct per-port offsets', () => {
    const snap = parseNetworkDevice(bufferReader(fixtureBuffer()), {
      tagName: 't',
      deviceName: 'd',
      capturedAt: 0,
    })
    // Port 1: i=0, multiplier=1
    expect(snap.ports[0].octetsIn).toBe(1_000_000)
    expect(snap.ports[0].errorsOut).toBe(5)
    // Port 10: i=9, multiplier=10
    expect(snap.ports[9].octetsIn).toBe(10_000_000)
    expect(snap.ports[9].discardsIn).toBe(10)
    expect(snap.ports[9].macRxErr).toBe(180)
    // Last port (32): i=31, multiplier=32
    expect(snap.ports[31].octetsOut).toBe(64_000_000)
    expect(snap.ports[31].speedMbps).toBe(10) // i>1 branch in fixture
  })

  it('parsePort honors absolute byte offset', () => {
    const buf = Buffer.alloc(200)
    // Put a port struct at offset 50 with one distinctive value
    buf.writeInt8(0b0001, 50) // linkUp
    buf.writeInt32LE(1000, 50 + NETWORK_NODE_LAYOUT.PORT.SPEED_MBPS)
    buf.writeInt32LE(999_999, 50 + NETWORK_NODE_LAYOUT.PORT.OCTETS_IN)

    const port = parsePort(bufferReader(buf), 50, 7)
    expect(port.portNumber).toBe(7)
    expect(port.linkUp).toBe(true)
    expect(port.speedMbps).toBe(1000)
    expect(port.octetsIn).toBe(999_999)
  })
})
