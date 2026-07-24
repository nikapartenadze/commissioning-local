/**
 * DLR (Device Level Ring) Object reader + ring-health verdict.
 *
 * Reads the CIP DLR Object (Class 0x47) off a 1756-EN2TR/EN4TR ring supervisor
 * via libplctag's `@raw` passthrough and turns it into a healthy/degraded/
 * unknown verdict for the Rockwell ring. READ-ONLY (Get_Attribute_Single).
 *
 * Design + provenance: frontend/specs/2026-05-26-network-ring-health-research.md.
 *
 * The pure helpers (buildDlrRequest / parseDlrReply / ringVerdict) are unit
 * tested in __tests__/dlr.test.ts. readDlrStatus() is the FFI read path —
 * field-verified against real EN4TR hardware (the dev Emulate 5580 has no DLR
 * object, so it returns null there → Unknown, by design).
 */

import {
  createRawTagAsync, plc_tag_set_size, plc_tag_set_uint8, writeTagAsync,
  plc_tag_get_size, plc_tag_get_raw_bytes, plc_tag_destroy, PlcTagStatus,
} from '../libplctag'

export const DLR_CLASS = 0x47
export const DLR_INSTANCE = 0x01
/** DLR read uses a short timeout — a present supervisor replies in <50ms; an
 *  absent module (emulator / wrong slot) times out, so keep the penalty small. */
const DLR_READ_TIMEOUT_MS = 2_000

/** DLR Attr 1 — Network Topology. */
export const TOPOLOGY = ['Linear', 'Ring'] as const
/** DLR Attr 2 — Network Status. */
export const NETWORK_STATUS = [
  'Normal',
  'Ring Fault',
  'Unexpected Loop Detected',
  'Partial Network Fault',
  'Rapid Fault/Restore Cycle',
] as const

/** A successful read of the DLR object's headline attributes. */
export interface DlrStatus {
  /** Attr 1 — 0=Linear, 1=Ring */
  topology: number
  /** Attr 2 — 0=Normal, 1=Ring Fault, … */
  networkStatus: number
  /** Attr 5 — ring faults since power-up (null if unread) */
  faultCount: number | null
  /** Attr 8 — number of ring participants (null if unread) */
  participants: number | null
  /** Attr 6 — IP of the last active node on supervisor port 1 (one side of a
   *  break), or null. On a ring fault, nodes 1 & 2 bracket the break. */
  lastActiveNode1: string | null
  /** Attr 7 — IP of the last active node on supervisor port 2, or null. */
  lastActiveNode2: string | null
}

export type RingState = 'healthy' | 'degraded' | 'unknown'

export interface RingStatus {
  state: RingState
  /** Human-readable reason (drives the UI subtitle). */
  reason: string
  topology?: number
  networkStatus?: number
  faultCount?: number | null
  participants?: number | null
  /** On a degraded ring, the two nodes bracketing the break (from the
   *  supervisor's Last Active Node on Port 1/2). */
  lastActiveNode1?: string | null
  lastActiveNode2?: string | null
}

/** Build a `@raw` Get_Attribute_Single (0x0E) request for DLR class 0x47 / inst 1 / `attr`. */
export function buildDlrRequest(attr: number): Uint8Array {
  // [service][path size in 16-bit WORDS][EPATH class, inst, attr] — 3 words = 6 bytes
  return Uint8Array.from([0x0e, 0x03, 0x20, DLR_CLASS, 0x24, DLR_INSTANCE, 0x30, attr])
}

/**
 * Parse a libplctag `@raw` CIP reply buffer.
 * Layout: [0]=reply_service [1]=reserved [2]=general status
 *         [3]=num extended-status words [4 + 2*words …]=attribute payload.
 */
export function parseDlrReply(raw: Buffer): { cipStatus: number; value: Buffer } {
  if (raw.length < 4) return { cipStatus: -1, value: Buffer.alloc(0) }
  const cipStatus = raw[2]
  const numStatusWords = raw[3]
  return { cipStatus, value: Buffer.from(raw.subarray(4 + 2 * numStatusWords)) }
}

/**
 * Decide the ring verdict. `null` (no read / no DLR object / timeout) and a
 * Linear topology both yield UNKNOWN — we never report `healthy` unless the
 * DLR object confirms Topology=Ring AND Status=Normal.
 */
export function ringVerdict(dlr: DlrStatus | null): RingStatus {
  if (!dlr) return { state: 'unknown', reason: 'No DLR object / not read' }
  const { topology, networkStatus, faultCount, participants, lastActiveNode1, lastActiveNode2 } = dlr
  const carry = { topology, networkStatus, faultCount, participants, lastActiveNode1, lastActiveNode2 }
  if (topology !== 1) {
    return { state: 'unknown', reason: 'Linear topology — not a DLR ring', ...carry }
  }
  if (networkStatus === 0) {
    return { state: 'healthy', reason: 'Ring closed (Normal)', ...carry }
  }
  return { state: 'degraded', reason: NETWORK_STATUS[networkStatus] ?? `Status ${networkStatus}`, ...carry }
}

/**
 * Parse the IP from a DLR "Last Active Node" struct (Attr 6/7): 4-byte IP
 * (UDINT) followed by a 6-byte MAC. Returns the dotted-quad IP, or null when
 * the node is all-zero (no localized break / not populated).
 * NOTE: bytes are taken in on-wire order; if a field capture shows the IP
 * reversed, flip the order here (unverifiable on the Emulate bench).
 */
export function parseRingNodeIp(value: Buffer): string | null {
  if (value.length < 4) return null
  const a = value[0], b = value[1], c = value[2], d = value[3]
  if ((a | b | c | d) === 0) return null
  return `${a}.${b}.${c}.${d}`
}

/**
 * Derive the backplane path to the DLR supervisor from discovered device tag
 * names. A `SLOTn_EN4TR`/`SLOTn_EN2TR` device → `"1,n"` (backplane port 1,
 * slot n). Returns undefined when no such device is present (caller then has
 * no DLR path and reports Unknown).
 */
export function deriveDlrPath(deviceNames: readonly string[]): string | undefined {
  for (const name of deviceNames) {
    const m = /(?:^|_)SLOT(\d+)_EN[24]TR/i.exec(name)
    if (m) return `1,${parseInt(m[1], 10)}`
  }
  return undefined
}

// ── FFI read path (not unit-tested — field-verified; see module header) ──────

async function getDlrAttr(
  gateway: string, path: string, attr: number, timeoutMs: number,
): Promise<{ transportOk: boolean; cipStatus: number; value: Buffer }> {
  const attribStr = `protocol=ab_eip&gateway=${gateway}&path=${path}&cpu=logix&name=@raw`
  // Non-blocking create: the sync plc_tag_create(attrib, timeoutMs) parked the
  // event loop for the whole session handshake (full timeoutMs on an absent
  // module). Unlike the sync create, a FAILED async create can still hold a
  // live handle — always destroy non-negative handles (the finally below).
  const { handle: tag, status: createStatus } = await createRawTagAsync(attribStr, timeoutMs)
  if (tag < 0) return { transportOk: false, cipStatus: -1, value: Buffer.alloc(0) }
  try {
    if (createStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return { transportOk: false, cipStatus: -1, value: Buffer.alloc(0) }
    }
    const req = buildDlrRequest(attr)
    plc_tag_set_size(tag, req.length)
    for (let i = 0; i < req.length; i++) plc_tag_set_uint8(tag, i, req[i])
    // @raw: the WRITE *sends* the CIP request (a read-only Get_Attribute_Single);
    // the reply lands back in the tag buffer. Nothing is written to the device.
    const status = await writeTagAsync(tag, timeoutMs)
    if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return { transportOk: false, cipStatus: -1, value: Buffer.alloc(0) }
    }
    const size = plc_tag_get_size(tag)
    const raw = Buffer.alloc(Math.max(0, size))
    if (size > 0) plc_tag_get_raw_bytes(tag, 0, raw)
    const parsed = parseDlrReply(raw)
    return { transportOk: true, cipStatus: parsed.cipStatus, value: parsed.value }
  } finally {
    try { plc_tag_destroy(tag) } catch { /* best-effort */ }
  }
}

/**
 * Read the DLR object's headline attributes (Topology, Network Status, Fault
 * Count, Participants) from the supervisor at gateway/path. Returns null when
 * the device has no DLR object or doesn't respond (timeout / CIP error) — the
 * caller treats null as "unknown" (never "healthy"). Read-only. Assumes the
 * libplctag library is already initialised (the poller does this).
 */
export async function readDlrStatus(
  gateway: string, path: string, timeoutMs: number = DLR_READ_TIMEOUT_MS,
): Promise<DlrStatus | null> {
  const a1 = await getDlrAttr(gateway, path, 1, timeoutMs)
  if (!a1.transportOk || a1.cipStatus !== 0 || a1.value.length < 1) return null
  const a2 = await getDlrAttr(gateway, path, 2, timeoutMs)
  if (!a2.transportOk || a2.cipStatus !== 0 || a2.value.length < 1) return null
  const a5 = await getDlrAttr(gateway, path, 5, timeoutMs)
  const a8 = await getDlrAttr(gateway, path, 8, timeoutMs)
  const a6 = await getDlrAttr(gateway, path, 6, timeoutMs)
  const a7 = await getDlrAttr(gateway, path, 7, timeoutMs)
  type Attr = { transportOk: boolean; cipStatus: number; value: Buffer }
  const u16 = (a: Attr) => (a.transportOk && a.cipStatus === 0 && a.value.length >= 2 ? a.value.readUInt16LE(0) : null)
  const node = (a: Attr) => (a.transportOk && a.cipStatus === 0 ? parseRingNodeIp(a.value) : null)
  return {
    topology: a1.value[0],
    networkStatus: a2.value[0],
    faultCount: u16(a5),
    participants: u16(a8),
    lastActiveNode1: node(a6),
    lastActiveNode2: node(a7),
  }
}
