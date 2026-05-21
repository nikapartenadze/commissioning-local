/**
 * Pure UDT_NETWORK_NODE_DATA byte parser.
 *
 * Side-effect-free: takes a `ByteReader` and produces a NetworkDeviceSnapshot.
 * The reader abstraction means the same parser works against:
 *   - a live libplctag handle (production path)
 *   - a Node Buffer (unit tests with fixture bytes)
 *
 * Layout constants live in `types.ts` and were derived from the L5X member
 * order, then sanity-checked at runtime by the caller via `plc_tag_get_size`.
 */

import {
  NETWORK_NODE_LAYOUT,
  type NetworkDeviceSnapshot,
  type PortStat,
} from './types';

/**
 * Abstract byte reader. Both methods take an absolute byte offset into the
 * tag's data buffer (the same convention libplctag uses).
 *
 * `bit` accepts an absolute bit offset (byte * 8 + bitWithinByte).
 */
export interface ByteReader {
  int8(offset: number): number;
  int16(offset: number): number;
  int32(offset: number): number;
  bit(bitOffset: number): boolean;
}

/**
 * Build a ByteReader backed by a Node Buffer. Used by tests and any future
 * "read once, parse later" path that wants to capture the wire bytes before
 * decoding. Little-endian to match Logix on-the-wire and libplctag's accessors.
 */
export function bufferReader(buf: Buffer): ByteReader {
  return {
    int8: (off) => buf.readInt8(off),
    int16: (off) => buf.readInt16LE(off),
    int32: (off) => buf.readInt32LE(off),
    bit: (bitOff) => {
      const byte = buf.readUInt8(Math.floor(bitOff / 8));
      return ((byte >> (bitOff % 8)) & 1) === 1;
    },
  };
}

/** Parse one UDT_PORT_DATA element starting at `portBase` byte offset. */
export function parsePort(read: ByteReader, portBase: number, portNumber: number): PortStat {
  const P = NETWORK_NODE_LAYOUT.PORT;
  const F = NETWORK_NODE_LAYOUT.PORT_FLAG_BITS;

  const flagsByteBitOffset = (portBase + P.FLAGS) * 8;

  return {
    portNumber,
    linkUp: read.bit(flagsByteBitOffset + F.LINK_UP),
    fullDuplex: read.bit(flagsByteBitOffset + F.FULL_DUPLEX),
    resetRequired: read.bit(flagsByteBitOffset + F.RESET_REQUIRED),
    hardwareFault: read.bit(flagsByteBitOffset + F.HARDWARE_FAULT),
    linkStatusRaw: read.int32(portBase + P.LINK_STATUS_RAW),
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
  for (let i = 0; i < NETWORK_NODE_LAYOUT.PORT_COUNT; i++) {
    const portBase = NETWORK_NODE_LAYOUT.PORTS_OFFSET + i * NETWORK_NODE_LAYOUT.PORT_SIZE;
    ports[i] = parsePort(read, portBase, i + 1);
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
