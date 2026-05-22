/**
 * Network Device Polling Types
 *
 * Mirrors the Logix UDTs from CDW5_MCM01_REV1.L5X. UDT_NETWORK_NODE_DATA is
 * composed of nested sub-UDTs (UDT_LINK_DATA, UDT_SPEED_DATA,
 * UDT_INTERFACE_COUNTERS, UDT_MEDIA_COUNTERS) — the byte layout below
 * unwinds them.
 *
 * Important quirks discovered during the audit against the real L5X
 * (vs. the older checkthis.L5X which had a different flat structure):
 *
 *   1. UDT_LINK_DATA puts the DINT `Link_Status_Raw` FIRST (offset 0), and
 *      the hidden SINT bit-target byte SECOND (offset 4). The earlier code
 *      had these swapped.
 *
 *   2. UDT_NETWORK_NODE_DATA's header is 6 bytes (INT + SINT + SINT + SINT[2])
 *      + 2 bytes padding for DINT alignment of the Ports array. Ports
 *      therefore starts at offset 8.
 *
 *   3. The Ports array is declared with Dimension=33 (1-based) — array index
 *      [0] is intentionally unused; valid ports are [1..32] = CIP Ethernet
 *      Link instances 1..32 = physical ports 1..32.
 *
 *   4. The PLC ladder (IOCT_COMMUNICATION_MONITOR routine) only MSG-writes
 *      `Link_Status_Raw` and the counter blocks. The SINT alias byte at
 *      offset 4 of UDT_LINK_DATA is populated via Logix bit-aliasing, which
 *      may or may not run depending on the ladder. So we derive linkUp,
 *      fullDuplex, etc. from `linkStatusRaw` bits directly (CIP-canonical),
 *      not from the alias byte. The L5X member comments confirm the CIP bit
 *      positions:
 *        bit 0 - Link Status (1 = active)
 *        bit 1 - Half/Full Duplex (1 = full)
 *        bit 5 - Manual setting requires reset
 *        bit 6 - Local hardware fault
 *
 *   5. Speed_Mbps (UDT_SPEED_DATA, separate CIP Attr 1) is NOT written by
 *      the current routine — readers will see 0 unless the ladder adds a
 *      Class 0xF6 Attr 1 MSG.
 *
 * Counters are raw cumulative CIP Ethernet Link Object values; consumers
 * should compute deltas across snapshots, not read absolute values.
 */

/**
 * One physical port on a network device. Field names match the L5X member names
 * verbatim so a grep across the firmware and the dashboard hits the same string.
 */
export interface PortStat {
  /** Physical port number, 1-indexed (matches Logix Ports[N] for N=1..32). */
  portNumber: number;

  /** bit 0 of Link_Status_Raw — port link active. */
  linkUp: boolean;
  /** bit 1 — full duplex when true. */
  fullDuplex: boolean;
  /** bit 5 — link parameter change requires Identity Object reset. */
  resetRequired: boolean;
  /** bit 6 — local hardware fault detected. */
  hardwareFault: boolean;

  /** Raw Interface Flags DWORD — Class 0xF6 Attr 2. Source of truth for the bit flags above. */
  linkStatusRaw: number;
  /**
   * Current interface speed in Mbps (0/10/100/1000) — Attr 1.
   * NOTE: only populated if the PLC ladder MSG-reads Class 0xF6 Attr 1; the
   * IOCT_COMMUNICATION_MONITOR routine in CDW5_MCM01_REV1.L5X does not, so
   * this stays 0 on those sites.
   */
  speedMbps: number;

  // Interface Counters (Class 0xF6 Attr 4) — 11 DINTs
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
  // Media Counters (Class 0xF6 Attr 5) — 12 DINTs
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
  /** CIP Identity Object Class 0x01 Attr 3 — vendor product code. May be 0 if ladder hasn't populated. */
  productCode: number;
  /** Identity Object Attr 4 — firmware major.minor. May be 0 if ladder hasn't populated. */
  firmwareMajor: number;
  firmwareMinor: number;
  /** Physical ports 1..32 in order. Inactive / unused ports still appear with linkUp=false. */
  ports: PortStat[];
  /** ms since epoch when the PLC read completed. */
  capturedAt: number;
}

/**
 * Byte layout constants for UDT_NETWORK_NODE_DATA and UDT_PORT_DATA,
 * verified against CDW5_MCM01_REV1.L5X.
 *
 *  Header (8 B incl. padding):
 *    +0  INT     Product_Code
 *    +2  SINT    Firmware_Major
 *    +3  SINT    Firmware_Minor
 *    +4  SINT[2] Firmware           (destination of Firmware MSG; 2 B)
 *    +6  -- pad to DINT alignment --
 *
 *  Ports[33], 104 B each, starting at offset 8. Index [0] unused, [1..32] are real.
 *
 *  UDT_PORT_DATA (104 B) layout:
 *    UDT_LINK_DATA               +0..7   (DINT Link_Status_Raw at 0; SINT alias at 4; 3 B pad)
 *    UDT_SPEED_DATA              +8..11  (DINT Speed_Mbps)
 *    UDT_INTERFACE_COUNTERS      +12..55 (11 × DINT)
 *    UDT_MEDIA_COUNTERS          +56..103 (12 × DINT)
 *
 *  Runtime sanity check via `plc_tag_get_size` — the poller refuses to start
 *  if the reported size disagrees with TOTAL_SIZE.
 */
export const NETWORK_NODE_LAYOUT = {
  /** 8 B header (+ pad) + 33 × 104 B per-port = 3440 B. */
  TOTAL_SIZE: 8 + 33 * 104,
  /** Number of physical ports we surface to consumers (Logix indices 1..32). */
  PORT_COUNT: 32,
  /** Bytes per UDT_PORT_DATA element. */
  PORT_SIZE: 104,
  /**
   * Byte offset where Ports[0] begins. Ports[N] starts at PORTS_OFFSET + N*PORT_SIZE.
   * The parser skips array index [0] (unused per L5X comment).
   */
  PORTS_OFFSET: 8,
  /** Number of bytes from PORTS_OFFSET we expect to ignore (Ports[0] is reserved). */
  PORTS_RESERVED_HEAD: 104,

  HEADER: {
    PRODUCT_CODE: 0,    // INT,  2 B
    FIRMWARE_MAJOR: 2,  // SINT, 1 B
    FIRMWARE_MINOR: 3,  // SINT, 1 B
    // FIRMWARE[2] at 4..5 — opaque scratch destination for the Firmware MSG; not surfaced
  },

  /** Byte offsets WITHIN one UDT_PORT_DATA element. */
  PORT: {
    LINK_STATUS_RAW: 0,  // DINT — Interface Flags DWORD
    FLAGS: 4,            // SINT bit-alias byte (NOT read; we decode bits from LINK_STATUS_RAW instead)
    SPEED_MBPS: 8,       // DINT
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

  /**
   * Bit positions within Link_Status_Raw (CIP Class 0xF6 Attr 2 Interface Flags).
   * Authoritative — we decode flags from the DWORD because the ladder
   * doesn't reliably populate the SINT alias byte.
   */
  LINK_STATUS_BITS: {
    LINK_UP: 0,
    FULL_DUPLEX: 1,
    RESET_REQUIRED: 5,
    HARDWARE_FAULT: 6,
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
