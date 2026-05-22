import { describe, it, expect } from 'vitest'
import {
  bufferReader,
  parsePort,
  parseNetworkDevice,
} from '@/lib/plc/network/parser'
import { NETWORK_NODE_LAYOUT } from '@/lib/plc/network/types'

/**
 * Build a fixture buffer for one UDT_NETWORK_NODE_DATA tag, matching the
 * new.L5X layout: 8 B header (+ pad), then Ports[0..32] @ 108 B each
 * (UDT_PORT_DATA grew by the AdminState USINT + 3 B pad). Index [0] is
 * reserved/unused; indices [1..32] are the real ports.
 *
 * Counters fan out as monotonically increasing values so the parser can prove
 * it's reading the right offsets — if any field is one slot off, the
 * assertions catch it.
 */
function fixtureBuffer(): Buffer {
  const buf = Buffer.alloc(NETWORK_NODE_LAYOUT.TOTAL_SIZE)
  // Header
  buf.writeInt16LE(0x1234, NETWORK_NODE_LAYOUT.HEADER.PRODUCT_CODE)
  buf.writeInt8(7, NETWORK_NODE_LAYOUT.HEADER.FIRMWARE_MAJOR)
  buf.writeInt8(1, NETWORK_NODE_LAYOUT.HEADER.FIRMWARE_MINOR)

  // Write each physical port (Logix index 1..32) — index [0] left zeroed.
  for (let logixIndex = 1; logixIndex <= NETWORK_NODE_LAYOUT.PORT_COUNT; logixIndex++) {
    const base = NETWORK_NODE_LAYOUT.PORTS_OFFSET + logixIndex * NETWORK_NODE_LAYOUT.PORT_SIZE

    // Link_Status_Raw — encode link state via the real CIP bit positions.
    // For testing, set bit 0 (LINK_UP) and bit 1 (FULL_DUPLEX) on even ports,
    // and bit 6 (HARDWARE_FAULT) on port 5.
    let linkRaw = 0
    if (logixIndex % 2 === 1) linkRaw |= (1 << 0) | (1 << 1) // bits 0 + 1 — odd-numbered ports (1, 3, ...) link up + FDX
    if (logixIndex === 5) linkRaw |= 1 << 6                  // hardware fault on port 5
    buf.writeInt32LE(linkRaw, base + NETWORK_NODE_LAYOUT.PORT.LINK_STATUS_RAW)

    const P = NETWORK_NODE_LAYOUT.PORT
    const fields: [number, number][] = [
      [P.SPEED_MBPS, logixIndex === 1 ? 1000 : logixIndex === 2 ? 100 : 10],
      [P.OCTETS_IN, logixIndex * 1_000_000],
      [P.UCAST_IN, logixIndex * 10_000],
      [P.NUCAST_IN, logixIndex * 10],
      [P.DISCARDS_IN, logixIndex * 1],
      [P.ERRORS_IN, logixIndex * 2],
      [P.UNKNOWN_PROTOS_IN, logixIndex * 3],
      [P.OCTETS_OUT, logixIndex * 2_000_000],
      [P.UCAST_OUT, logixIndex * 20_000],
      [P.NUCAST_OUT, logixIndex * 20],
      [P.DISCARDS_OUT, logixIndex * 4],
      [P.ERRORS_OUT, logixIndex * 5],
      [P.ALIGN_ERR, logixIndex * 6],
      [P.FCS_ERR, logixIndex * 7],
      [P.SINGLE_COLL, logixIndex * 8],
      [P.MULTI_COLL, logixIndex * 9],
      [P.SQE_ERR, logixIndex * 11],
      [P.DEFERRED_TX, logixIndex * 12],
      [P.LATE_COLL, logixIndex * 13],
      [P.EXCESS_COLL, logixIndex * 14],
      [P.MAC_TX_ERR, logixIndex * 15],
      [P.CARRIER_SENSE, logixIndex * 16],
      [P.FRAME_TOO_LONG, logixIndex * 17],
      [P.MAC_RX_ERR, logixIndex * 18],
    ]
    for (const [off, value] of fields) {
      buf.writeInt32LE(value, base + off)
    }
    // AdminState (USINT). Even-port → Enable (1), odd-port → Disable (2),
    // gives both nonzero values to assert against.
    buf.writeUInt8(logixIndex % 2 === 0 ? 1 : 2, base + P.ADMIN_STATE)
  }
  // Poison Ports[0] with non-zero bytes — parser MUST skip it. If anything
  // leaks through, the test below catches it.
  for (let i = 0; i < NETWORK_NODE_LAYOUT.PORT_SIZE; i++) {
    buf.writeInt8(-1, NETWORK_NODE_LAYOUT.PORTS_OFFSET + i)
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

  it('skips the reserved Ports[0] (parser must not read from PORTS_OFFSET..+103)', () => {
    // The fixture poisons Ports[0] with 0xFF. If the parser leaked Ports[0]
    // into the output array, the first port would have huge negative-int32
    // values everywhere. With the correct layout, ports[0] in our output is
    // Logix Ports[1] — clean values.
    const snap = parseNetworkDevice(bufferReader(fixtureBuffer()), {
      tagName: 't', deviceName: 'd', capturedAt: 0,
    })
    expect(snap.ports[0].portNumber).toBe(1)
    expect(snap.ports[0].octetsIn).toBe(1_000_000) // not -1 / not 0xFFFFFFFF
    expect(snap.ports[31].portNumber).toBe(32)
  })

  it('derives port flag bits from Link_Status_Raw, not from the SINT alias', () => {
    const snap = parseNetworkDevice(bufferReader(fixtureBuffer()), {
      tagName: 't', deviceName: 'd', capturedAt: 0,
    })
    // Odd-indexed physical ports (1, 3, 5, ...) have linkUp + fullDuplex.
    expect(snap.ports[0].linkUp).toBe(true)         // port 1
    expect(snap.ports[0].fullDuplex).toBe(true)
    expect(snap.ports[0].hardwareFault).toBe(false)
    // Even-indexed ports (2, 4, ...) have no flags.
    expect(snap.ports[1].linkUp).toBe(false)        // port 2
    expect(snap.ports[1].fullDuplex).toBe(false)
    // Port 5 has hardwareFault (bit 6) AND linkUp (bit 0, odd port).
    expect(snap.ports[4].linkUp).toBe(true)         // port 5
    expect(snap.ports[4].hardwareFault).toBe(true)
    // linkStatusRaw is exposed verbatim for advanced consumers.
    expect(snap.ports[4].linkStatusRaw & (1 << 6)).not.toBe(0)
  })

  it('parses port counters using distinct per-port offsets', () => {
    const snap = parseNetworkDevice(bufferReader(fixtureBuffer()), {
      tagName: 't', deviceName: 'd', capturedAt: 0,
    })
    // Port 1
    expect(snap.ports[0].octetsIn).toBe(1_000_000)
    expect(snap.ports[0].errorsOut).toBe(5)
    // Port 10
    expect(snap.ports[9].octetsIn).toBe(10_000_000)
    expect(snap.ports[9].discardsIn).toBe(10)
    expect(snap.ports[9].macRxErr).toBe(180)
    // Port 32 (last)
    expect(snap.ports[31].octetsOut).toBe(64_000_000)
    expect(snap.ports[31].speedMbps).toBe(10)
  })

  it('parsePort honors absolute byte offset', () => {
    const buf = Buffer.alloc(200)
    // Put a port struct at offset 50 with one distinctive value
    buf.writeInt32LE((1 << 0) | (1 << 1), 50 + NETWORK_NODE_LAYOUT.PORT.LINK_STATUS_RAW) // linkUp + fullDuplex
    buf.writeInt32LE(1000, 50 + NETWORK_NODE_LAYOUT.PORT.SPEED_MBPS)
    buf.writeInt32LE(999_999, 50 + NETWORK_NODE_LAYOUT.PORT.OCTETS_IN)

    const port = parsePort(bufferReader(buf), 50, 7)
    expect(port.portNumber).toBe(7)
    expect(port.linkUp).toBe(true)
    expect(port.fullDuplex).toBe(true)
    expect(port.speedMbps).toBe(1000)
    expect(port.octetsIn).toBe(999_999)
  })

  it('TOTAL_SIZE matches the L5X UDT size (8 B header + 33 × 108 B ports incl. AdminState)', () => {
    expect(NETWORK_NODE_LAYOUT.TOTAL_SIZE).toBe(8 + 33 * 108)
    expect(NETWORK_NODE_LAYOUT.PORTS_OFFSET).toBe(8)
    expect(NETWORK_NODE_LAYOUT.PORT_COUNT).toBe(32)
    expect(NETWORK_NODE_LAYOUT.PORT_SIZE).toBe(108)
    expect(NETWORK_NODE_LAYOUT.PORT.ADMIN_STATE).toBe(104)
  })

  it('reads AdminState (USINT) per port', () => {
    const snap = parseNetworkDevice(bufferReader(fixtureBuffer()), {
      tagName: 't', deviceName: 'd', capturedAt: 0,
    })
    // Port 1 (odd) → 2 (Disable in fixture)
    expect(snap.ports[0].adminState).toBe(2)
    // Port 2 (even) → 1 (Enable)
    expect(snap.ports[1].adminState).toBe(1)
    // Port 32 (even) → 1 (Enable)
    expect(snap.ports[31].adminState).toBe(1)
  })
})
