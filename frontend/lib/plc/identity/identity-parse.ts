/**
 * Pure CIP Identity Object (Class 0x01) request builder + reply parser.
 *
 * Side-effect-free: builds the `Get_Attributes_All` request bytes and parses a
 * libplctag `@raw` reply buffer into a DeviceIdentity. The FFI read path lives
 * in identity-reader.ts; these helpers are unit-tested in
 * __tests__/identity-parse.test.ts.
 *
 * The Identity Object's Get_Attributes_All (service 0x01) reply payload is, in
 * order (all little-endian, matching Logix on-the-wire / libplctag accessors):
 *
 *   +0  UINT          Vendor ID
 *   +2  UINT          Device Type
 *   +4  UINT          Product Code            ← baseline key
 *   +6  USINT         Major Revision          ← firmware (bit 7 reserved)
 *   +7  USINT         Minor Revision          ← firmware
 *   +8  WORD          Status
 *   +10 UDINT         Serial Number
 *   +14 SHORT_STRING  Product Name            (1 length byte + N chars)
 *
 * Reply framing matches every other libplctag @raw reply (see network/dlr.ts):
 *   [0]=reply_service [1]=reserved [2]=general status
 *   [3]=num extended-status words [4 + 2*words …]=attribute payload
 */

export const IDENTITY_CLASS = 0x01
export const IDENTITY_INSTANCE = 0x01
/** CIP common service: Get_Attributes_All. */
export const GET_ATTRIBUTES_ALL = 0x01

/** Byte offset of the first variable-length field (Product Name length byte). */
const PRODUCT_NAME_LEN_OFFSET = 14

/** A device's CIP Identity, as read off the Identity Object. */
export interface DeviceIdentity {
  vendorId: number
  deviceType: number
  /** Identity Attr 3 — used (with vendorId) as the firmware-baseline key. */
  productCode: number
  /** Major firmware revision (reserved high bit masked off). */
  revMajor: number
  /** Minor firmware revision. */
  revMinor: number
  status: number
  serial: number
  /** Device's own model string, e.g. "1756-L85E/B". */
  productName: string
}

/**
 * Build a `@raw` Get_Attributes_All (0x01) request for Identity class 0x01,
 * instance 1. No attribute segment — Get_Attributes_All returns the whole
 * fixed attribute set.
 *   [service][path size in 16-bit WORDS][EPATH class][EPATH instance]
 */
export function buildIdentityRequest(): Uint8Array {
  // 2 words of EPATH: 0x20=class-8bit, 0x24=instance-8bit
  return Uint8Array.from([GET_ATTRIBUTES_ALL, 0x02, 0x20, IDENTITY_CLASS, 0x24, IDENTITY_INSTANCE])
}

/**
 * Parse a libplctag `@raw` CIP reply buffer into a general status + value
 * payload. Identical framing to network/dlr.ts#parseDlrReply.
 */
export function parseCipReply(raw: Buffer): { cipStatus: number; value: Buffer } {
  if (raw.length < 4) return { cipStatus: -1, value: Buffer.alloc(0) }
  const cipStatus = raw[2]
  const numStatusWords = raw[3]
  return { cipStatus, value: Buffer.from(raw.subarray(4 + 2 * numStatusWords)) }
}

/**
 * Parse the Identity attribute payload (the bytes AFTER the 4-byte CIP reply
 * header). Returns null when the buffer is too short to hold the fixed fields.
 * A truncated Product Name is tolerated — we read as many chars as are present.
 */
export function parseIdentityValue(value: Buffer): DeviceIdentity | null {
  // Need at least through the Product Name length byte (offset 14).
  if (value.length < PRODUCT_NAME_LEN_OFFSET + 1) return null

  const nameLen = value.readUInt8(PRODUCT_NAME_LEN_OFFSET)
  const nameStart = PRODUCT_NAME_LEN_OFFSET + 1
  const nameEnd = Math.min(nameStart + nameLen, value.length)
  const productName = value.toString('latin1', nameStart, nameEnd).replace(/\0+$/, '').trim()

  return {
    vendorId: value.readUInt16LE(0),
    deviceType: value.readUInt16LE(2),
    productCode: value.readUInt16LE(4),
    // CIP Vol1: Major Revision is bits 0-6; bit 7 is reserved (compatibility).
    revMajor: value.readUInt8(6) & 0x7f,
    revMinor: value.readUInt8(7),
    status: value.readUInt16LE(8),
    serial: value.readUInt32LE(10),
    productName,
  }
}

/**
 * Parse a full `@raw` Identity reply. Returns the CIP general status and the
 * DeviceIdentity (null on any CIP error or malformed/short payload).
 */
export function parseIdentityReply(raw: Buffer): { cipStatus: number; identity: DeviceIdentity | null } {
  const { cipStatus, value } = parseCipReply(raw)
  if (cipStatus !== 0) return { cipStatus, identity: null }
  return { cipStatus, identity: parseIdentityValue(value) }
}
