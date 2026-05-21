/**
 * Network Device Polling Types
 *
 * Mirrors the Logix UDTs from the L5X (see checkthis.L5X):
 *   - UDT_NETWORK_NODE_DATA  per device, tag named "<Device>_NetworkNode" / "<Device>_NN.Data"
 *   - UDT_PORT_DATA          per port (32 per device, index 0 = CIP Instance 1 = physical Port 1)
 *
 * Counters are raw CIP Ethernet Link Object (Class 0xF6) values — they reset only
 * when the device resets, so consumers should compute deltas across snapshots.
 */

/**
 * One physical port on a network device. Field names match the L5X member names
 * verbatim so a grep across the firmware and the dashboard hits the same string.
 */
export interface PortStat {
  /** Physical port number, 1-indexed. PLC index = portNumber - 1. */
  portNumber: number;

  /** bit 0 of Interface Flags — port link active. */
  linkUp: boolean;
  /** bit 1 — full duplex when true. */
  fullDuplex: boolean;
  /** bit 5 — link parameter change requires Identity Object reset. */
  resetRequired: boolean;
  /** bit 6 — local hardware fault detected. */
  hardwareFault: boolean;

  /** Raw Interface Flags DWORD — Class 0xF6 Attr 2. Retained so consumers can decode extra bits later. */
  linkStatusRaw: number;
  /** Current interface speed in Mbps (0/10/100/1000) — Attr 1. */
  speedMbps: number;

  // Counters (all DINT, CIP Ethernet Link Class 0xF6 / Interface Counters Class 0xF6 Attr 4)
  octetsIn: number;
  ucastIn: number;
  nucastIn: number;
  discardsIn: number;
  errorsIn: number;
  unknownProtosIn: number;
  octetsOut: number;
  ucastOut: number;
  nucastOut: number;
  discardsOut: number;
  errorsOut: number;
  // Media Counters Attr 5
  alignErr: number;
  fcsErr: number;
  singleColl: number;
  multiColl: number;
  sqeErr: number;
  deferredTx: number;
  lateColl: number;
  excessColl: number;
  macTxErr: number;
  carrierSense: number;
  frameTooLong: number;
  macRxErr: number;
}

/**
 * One full snapshot of a single network device, captured in a single PLC read.
 */
export interface NetworkDeviceSnapshot {
  /** The PLC tag name we read (e.g. "SLOT2_EN4TR_NetworkNode" or "UL17_8_DPM1_NN.Data"). */
  tagName: string;
  /** Device name with the discovered suffix stripped (e.g. "SLOT2_EN4TR"). */
  deviceName: string;
  /** CIP Identity Object Class 0x01 Attr 3 — vendor product code. */
  productCode: number;
  /** Identity Object Attr 4 — firmware major.minor. */
  firmwareMajor: number;
  firmwareMinor: number;
  /** All 32 port slots in PLC index order. Inactive ports still appear with linkUp=false. */
  ports: PortStat[];
  /** ms since epoch when the PLC read completed. */
  capturedAt: number;
}

/**
 * Byte layout constants for UDT_NETWORK_NODE_DATA and UDT_PORT_DATA.
 *
 * Logix UDTs pack DINTs on 4-byte alignment. The Ports array starts at offset 4
 * (after the INT + two SINTs, which together fit in 4 bytes).
 *
 * Verified against the L5X member order at checkthis.L5X:3155-3328. Sizes are
 * also verified at runtime via `plc_tag_get_size` so a firmware-padding change
 * surfaces as a parse error instead of silent misalignment.
 */
export const NETWORK_NODE_LAYOUT = {
  /** UDT_NETWORK_NODE_DATA: 4-byte header + 32 * 104-byte port = 3332 B. */
  TOTAL_SIZE: 4 + 32 * 104,
  PORT_COUNT: 32,
  PORT_SIZE: 104,
  PORTS_OFFSET: 4,

  HEADER: {
    PRODUCT_CODE: 0,    // INT, 2 B
    FIRMWARE_MAJOR: 2,  // SINT, 1 B
    FIRMWARE_MINOR: 3,  // SINT, 1 B
  },

  /** Byte offsets WITHIN one UDT_PORT_DATA element. */
  PORT: {
    FLAGS: 0,           // SINT packed bits: 0=Link_Up, 1=Full_Duplex, 2=Reset_Required, 3=Hardware_Fault
    LINK_STATUS_RAW: 4, // DINT
    SPEED_MBPS: 8,      // DINT
    OCTETS_IN: 12,
    UCAST_IN: 16,
    NUCAST_IN: 20,
    DISCARDS_IN: 24,
    ERRORS_IN: 28,
    UNKNOWN_PROTOS_IN: 32,
    OCTETS_OUT: 36,
    UCAST_OUT: 40,
    NUCAST_OUT: 44,
    DISCARDS_OUT: 48,
    ERRORS_OUT: 52,
    ALIGN_ERR: 56,
    FCS_ERR: 60,
    SINGLE_COLL: 64,
    MULTI_COLL: 68,
    SQE_ERR: 72,
    DEFERRED_TX: 76,
    LATE_COLL: 80,
    EXCESS_COLL: 84,
    MAC_TX_ERR: 88,
    CARRIER_SENSE: 92,
    FRAME_TOO_LONG: 96,
    MAC_RX_ERR: 100,
  },

  PORT_FLAG_BITS: {
    LINK_UP: 0,
    FULL_DUPLEX: 1,
    RESET_REQUIRED: 2,
    HARDWARE_FAULT: 3,
  },
} as const;

/**
 * Tag-name suffixes we try when discovering network device tags. Order matters —
 * the first hit per device wins. Add new patterns at the end so older sites
 * keep matching their existing suffix.
 */
export const NETWORK_TAG_SUFFIXES = ['_NetworkNode', '_NN.Data', '_NN'] as const;

/**
 * Strip a known network-tag suffix off a tag name to get the device name.
 * Returns null if no suffix matched.
 */
export function stripNetworkTagSuffix(tagName: string): string | null {
  for (const suffix of NETWORK_TAG_SUFFIXES) {
    if (tagName.endsWith(suffix)) {
      return tagName.slice(0, -suffix.length);
    }
  }
  return null;
}
