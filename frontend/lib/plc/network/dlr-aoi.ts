/**
 * PLC-side DLR decode — `AOI_RACK_NETWORK_NODE` controller tags.
 *
 * WHAT THE PLC ALREADY DOES FOR US
 * --------------------------------
 * The customer's programs instantiate an AOI (`AOI_RACK_NETWORK_NODE`) once per
 * rack Ethernet module. That AOI *self-polls* the CIP DLR Object (class 0x47)
 * every 500 ms using MSG instructions and parks the results in controller tags.
 * The commissioning tool therefore does NOT need `@raw` CIP passthrough, does
 * NOT need to trigger anything, and MUST NOT write: it just READS four tags.
 *
 * (Contrast with `./dlr.ts`, which talks the DLR object directly off a ring
 * supervisor. That path stays for racks whose program has no AOI.)
 *
 * TAG CONTRACT (base = `<MCM>_SLOT<n>_EN[24]TR`, e.g. `MCM08_SLOT2_EN4TR`)
 * ----------------------------------------------------------------------
 *   <base>.AOI.DLR_Break_Present       SINT      raw DLR Network Status (attr 0x02)
 *   <base>.AOI.Communication_Faulted   BOOL      module comms fault (GSV FaultCode != 0)
 *   <base>.HMI.DLR_Break_Point1_Data   SINT[10]  attr 0x06 Last Active Node, port 1
 *   <base>.HMI.DLR_Break_Point2_Data   SINT[10]  attr 0x07 Last Active Node, port 2
 *
 * Each Break_Point array is 10 bytes: [0..3] IPv4, [4..9] MAC. The PLC
 * zero-fills BOTH arrays on every scan while the ring is healthy, so all-zero
 * means "healthy or never populated" — never "some unknown node".
 *
 * TWO TRAPS (both are why this module exists)
 * -------------------------------------------
 * 1. The AOI's own `DLR_Broken` output flag is computed as a bit-0 test of the
 *    status byte. That MISSES status 2 (Unexpected Loop Detected) and 4 (Rapid
 *    Fault/Restore Cycle) — both are real ring problems that the flag reports
 *    as healthy. We decode the FULL enumeration instead, so this module is
 *    strictly more correct than the PLC's flag.
 * 2. `DLR_Broken` is declared ExternalAccess="None" and CANNOT be read from
 *    outside the controller at all. Never depend on it.
 *
 * Also mirrored from the AOI: it suppresses DLR evaluation entirely while
 * `Communication_Faulted` is true. We give that its own state (`comm-fault`)
 * rather than laundering it into a ring fault — a module we cannot talk to
 * tells us nothing about the ring.
 *
 * SINT is signed in Logix (-128..127); every byte here is normalised to
 * unsigned 0-255 before it is interpreted.
 *
 * Pure module: no I/O, no db, no plc client. Unit tested in
 * __tests__/dlr-aoi.test.ts.
 */

/** CIP DLR Object attribute 0x02 — Network Status enumeration. */
export const DLR_NETWORK_STATUS: readonly string[] = [
  'Normal',
  'Ring Fault',
  'Unexpected Loop Detected',
  'Partial Network Fault',
  'Rapid Fault/Restore Cycle',
]

/** One side of a ring break, decoded from a Break_Point SINT[10]. */
export interface DlrBreakNode {
  /** Dotted-quad IPv4 from bytes 0-3, or null when unpopulated. */
  ip: string | null
  /** Lowercase colon-separated MAC from bytes 4-9, or null when unpopulated. */
  mac: string | null
}

/** Raw tag values as read off the controller. */
export interface DlrAoiReading {
  /** `<base>.AOI.DLR_Break_Present` — raw status byte; null if the tag was not read. */
  breakPresent: number | null
  /** `<base>.AOI.Communication_Faulted`. */
  communicationFaulted: boolean
  /** `<base>.HMI.DLR_Break_Point1_Data` raw bytes (may be empty or short). */
  point1: number[]
  /** `<base>.HMI.DLR_Break_Point2_Data` raw bytes (may be empty or short). */
  point2: number[]
}

export type DlrAoiState = 'healthy' | 'broken' | 'comm-fault' | 'unknown'

/** Flat shape on purpose — tsconfig.server.json runs strict:false, where
 *  discriminated-union narrowing on negative branches does not hold. */
export interface DlrAoiVerdict {
  state: DlrAoiState
  /** Human-readable, specific — drives the UI subtitle. */
  reason: string
  /** Raw status byte (normalised unsigned), or null when unread/not applicable. */
  statusCode: number | null
  /** Enum label for statusCode, or null when out of enumeration / unread. */
  statusLabel: string | null
  /** The two nodes bracketing the break, when the PLC localized it. */
  breakBetween: [DlrBreakNode, DlrBreakNode] | null
}

/** Normalise a possibly-signed Logix SINT (-128..127) to unsigned 0-255. */
function toUnsignedByte(value: number): number {
  return ((Math.trunc(value) % 256) + 256) % 256
}

/**
 * Decode a Break_Point SINT[10] into `{ ip, mac }`: bytes 0-3 are the IPv4
 * address, bytes 4-9 the MAC. Returns `{ ip: null, mac: null }` when the array
 * is shorter than 10 bytes or is entirely zero — the PLC zero-fills these every
 * scan while the ring is healthy, so all-zero is "nothing to report".
 */
export function parseBreakNode(bytes: number[]): DlrBreakNode {
  if (!Array.isArray(bytes) || bytes.length < 10) return { ip: null, mac: null }
  const b = bytes.slice(0, 10).map(toUnsignedByte)
  if (b.every((x) => x === 0)) return { ip: null, mac: null }
  const ip = `${b[0]}.${b[1]}.${b[2]}.${b[3]}`
  const mac = b.slice(4, 10).map((x) => x.toString(16).padStart(2, '0')).join(':')
  return { ip, mac }
}

/**
 * Turn a reading of the four AOI tags into a ring verdict.
 *
 * Precedence (mirrors the AOI's own gating, then fixes its bit-0 bug):
 *   1. Communication_Faulted  -> 'comm-fault' (ring state cannot be judged)
 *   2. status tag unread      -> 'unknown'
 *   3. status 0               -> 'healthy'
 *   4. status 1..4            -> 'broken', reason = the enum label
 *   5. anything else          -> 'broken', reason = `Unknown DLR status <n>`
 */
export function decodeDlrAoi(r: DlrAoiReading): DlrAoiVerdict {
  if (r.communicationFaulted) {
    return {
      state: 'comm-fault',
      reason: 'Module is not communicating (Communication_Faulted) — ring state cannot be judged',
      statusCode: null,
      statusLabel: null,
      breakBetween: null,
    }
  }

  if (r.breakPresent === null || r.breakPresent === undefined) {
    return {
      state: 'unknown',
      reason: 'DLR status tag could not be read',
      statusCode: null,
      statusLabel: null,
      breakBetween: null,
    }
  }

  const status = toUnsignedByte(r.breakPresent)

  if (status === 0) {
    return {
      state: 'healthy',
      reason: 'Ring closed (Normal)',
      statusCode: 0,
      statusLabel: DLR_NETWORK_STATUS[0],
      breakBetween: null,
    }
  }

  const label = status < DLR_NETWORK_STATUS.length ? DLR_NETWORK_STATUS[status] : null
  const node1 = parseBreakNode(r.point1 ?? [])
  const node2 = parseBreakNode(r.point2 ?? [])
  const breakBetween: [DlrBreakNode, DlrBreakNode] | null =
    node1.ip !== null || node2.ip !== null ? [node1, node2] : null

  return {
    state: 'broken',
    reason: label ?? `Unknown DLR status ${status}`,
    statusCode: status,
    statusLabel: label,
    breakBetween,
  }
}

/**
 * Fully-qualified tag paths for one AOI instance. Arrays get a `[0]` element
 * suffix because that is what libplctag needs to address a SINT[] read; the
 * scalars are addressed bare.
 */
export function dlrTagNames(base: string): {
  breakPresent: string
  commFaulted: string
  point1: string
  point2: string
} {
  return {
    breakPresent: `${base}.AOI.DLR_Break_Present`,
    commFaulted: `${base}.AOI.Communication_Faulted`,
    point1: `${base}.HMI.DLR_Break_Point1_Data[0]`,
    point2: `${base}.HMI.DLR_Break_Point2_Data[0]`,
  }
}

/**
 * Derive the AOI tag base from discovered device tag names. A device named
 * `SLOTn_EN4TR` (or `..._EN2TR`) under MCM `mcmName` yields
 * `<mcmName>_SLOTn_EN4TR`. The EN2TR/EN4TR distinction is preserved from the
 * matched name. Returns null when no rack Ethernet module is present.
 */
export function deriveAoiBase(deviceNames: readonly string[], mcmName: string): string | null {
  if (!mcmName) return null
  for (const name of deviceNames ?? []) {
    const m = /(?:^|_)SLOT(\d+)_(EN[24]TR)/i.exec(name)
    if (m) return `${mcmName}_SLOT${parseInt(m[1], 10)}_${m[2].toUpperCase()}`
  }
  return null
}
