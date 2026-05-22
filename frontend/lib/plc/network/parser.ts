/**
 * Pure UDT_NETWORK_NODE_DATA byte parser.
 *
 * Side-effect-free: takes a `ByteReader` and produces a NetworkDeviceSnapshot.
 * The reader abstraction means the same parser works against:
 *   - a live libplctag handle (production path)
 *   - a Node Buffer (unit tests with fixture bytes)
 *
 * Layout constants live in `types.ts` and were derived from the
 * CDW5_MCM01_REV1.L5X UDT member order. The poller sanity-checks the runtime
 * tag size against NETWORK_NODE_LAYOUT.TOTAL_SIZE before publishing snapshots.
 */

import {
  NETWORK_NODE_LAYOUT,
  type NetworkDeviceSnapshot,
  type PortStat,
} from './types';

/**
 * Abstract byte reader. Both methods take an absolute byte offset into the
 * tag's data buffer (the same convention libplctag uses).
 */
export interface ByteReader {
  int8(offset: number): number;
  int16(offset: number): number;
  int32(offset: number): number;
}

/**
 * Build a ByteReader backed by a Node Buffer. Used by tests and any future
 * "read once, parse later" path. Little-endian to match Logix on-the-wire
 * and libplctag's accessors.
 */
export function bufferReader(buf: Buffer): ByteReader {
  return {
    int8: (off) => buf.readInt8(off),
    int16: (off) => buf.readInt16LE(off),
    int32: (off) => buf.readInt32LE(off),
  };
}

/** Extract a single bit from an integer (treating it as unsigned for bit ops). */
function bit(value: number, bitIndex: number): boolean {
  return ((value >>> bitIndex) & 1) === 1;
}

/** Parse one UDT_PORT_DATA element starting at `portBase` byte offset. */
export function parsePort(read: ByteReader, portBase: number, portNumber: number): PortStat {
  const P = NETWORK_NODE_LAYOUT.PORT;
  const B = NETWORK_NODE_LAYOUT.LINK_STATUS_BITS;

  // Read Link_Status_Raw first and decode flags from it directly. The SINT
  // bit-alias byte at portBase + P.FLAGS is intentionally NOT read because
  // the PLC ladder doesn't reliably populate it (see types.ts header notes).
  const linkStatusRaw = read.int32(portBase + P.LINK_STATUS_RAW);

  return {
    portNumber,
    linkUp: bit(linkStatusRaw, B.LINK_UP),
    fullDuplex: bit(linkStatusRaw, B.FULL_DUPLEX),
    resetRequired: bit(linkStatusRaw, B.RESET_REQUIRED),
    hardwareFault: bit(linkStatusRaw, B.HARDWARE_FAULT),
    linkStatusRaw,
    speedMbps: read.int32(portBase + P.SPEED_MBPS),
    octetsIn: read.int32(portBase + P.OCTETS_IN),
    ucastIn: read.int32(portBase + P.UCAST_IN),
    nucastIn: read.int32(portBase + P.NUCAST_IN),
    discardsIn: read.int32(portBase + P.DISCARDS_IN),
    errorsIn: read.int32(portBase + P.ERRORS_IN),
    unknownProtosIn: read.int32(portBase + P.UNKNOWN_PROTOS_IN),
    octetsOut: read.int32(portBase + P.OCTETS_OUT),
    ucastOut: read.int32(portBase + P.UCAST_OUT),
    nucastOut: read.int32(portBase + P.NUCAST_OUT),
    discardsOut: read.int32(portBase + P.DISCARDS_OUT),
    errorsOut: read.int32(portBase + P.ERRORS_OUT),
    alignErr: read.int32(portBase + P.ALIGN_ERR),
    fcsErr: read.int32(portBase + P.FCS_ERR),
    singleColl: read.int32(portBase + P.SINGLE_COLL),
    multiColl: read.int32(portBase + P.MULTI_COLL),
    sqeErr: read.int32(portBase + P.SQE_ERR),
    deferredTx: read.int32(portBase + P.DEFERRED_TX),
    lateColl: read.int32(portBase + P.LATE_COLL),
    excessColl: read.int32(portBase + P.EXCESS_COLL),
    macTxErr: read.int32(portBase + P.MAC_TX_ERR),
    carrierSense: read.int32(portBase + P.CARRIER_SENSE),
    frameTooLong: read.int32(portBase + P.FRAME_TOO_LONG),
    macRxErr: read.int32(portBase + P.MAC_RX_ERR),
  };
}

/** Parse a whole UDT_NETWORK_NODE_DATA buffer into a NetworkDeviceSnapshot. */
export function parseNetworkDevice(
  read: ByteReader,
  args: { tagName: string; deviceName: string; capturedAt: number },
): NetworkDeviceSnapshot {
  const H = NETWORK_NODE_LAYOUT.HEADER;

  const ports: PortStat[] = new Array(NETWORK_NODE_LAYOUT.PORT_COUNT);
  // L5X declares Ports as Dimension="33" with index [0] reserved/unused.
  // Iterate Logix indices 1..32 and emit physical port numbers 1..32.
  for (let i = 0; i < NETWORK_NODE_LAYOUT.PORT_COUNT; i++) {
    const logixIndex = i + 1;
    const portBase = NETWORK_NODE_LAYOUT.PORTS_OFFSET + logixIndex * NETWORK_NODE_LAYOUT.PORT_SIZE;
    ports[i] = parsePort(read, portBase, logixIndex);
  }

  return {
    tagName: args.tagName,
    deviceName: args.deviceName,
    productCode: read.int16(H.PRODUCT_CODE),
    firmwareMajor: read.int8(H.FIRMWARE_MAJOR),
    firmwareMinor: read.int8(H.FIRMWARE_MINOR),
    ports,
    capturedAt: args.capturedAt,
  };
}
