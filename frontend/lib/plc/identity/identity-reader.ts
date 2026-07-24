/**
 * CIP Identity Object reader (firmware/model probe).
 *
 * Reads the CIP Identity Object (Class 0x01, Instance 1) off any reachable
 * EtherNet/IP node — controller, Ethernet bridge module, drive, etc. — via
 * libplctag's `@raw` passthrough, returning the device's vendor/product/
 * revision/serial/name. READ-ONLY (Get_Attributes_All).
 *
 * This is the FFI counterpart to the pure helpers in identity-parse.ts and is
 * a direct sibling of network/dlr.ts#getDlrAttr — same @raw write-sends-request,
 * reply-lands-in-buffer pattern. NOT unit-tested: it must be field-verified
 * against the test emulator (192.168.5.106) and a real controller.
 *
 * Assumes the libplctag library is already initialised (the PLC client /
 * network poller does this at connect time).
 */

import {
  createRawTagAsync, plc_tag_set_size, plc_tag_set_uint8, writeTagAsync,
  plc_tag_get_size, plc_tag_get_raw_bytes, plc_tag_destroy, PlcTagStatus,
} from '../libplctag'
import { buildIdentityRequest, parseIdentityReply, type DeviceIdentity } from './identity-parse'

/** Identity reads are one-shot; a present node replies in <50ms, an absent
 *  path times out, so keep the per-device penalty small. */
export const IDENTITY_READ_TIMEOUT_MS = 2_000

/**
 * Read the Identity Object from the device at `gateway` reachable over routing
 * `path` (e.g. "1,0" = backplane slot 0, the local controller; "1,2,A,<ip>,1,0"
 * = out an Ethernet port to a remote node). Returns null when the node does not
 * respond or returns a CIP error — the caller treats null as "unreachable"
 * (never a passing compliance verdict). Read-only.
 */
export async function readIdentity(
  gateway: string,
  path: string,
  timeoutMs: number = IDENTITY_READ_TIMEOUT_MS,
): Promise<DeviceIdentity | null> {
  const attribStr = `protocol=ab_eip&gateway=${gateway}&path=${path}&cpu=logix&name=@raw`
  // Non-blocking create: the sync plc_tag_create(attrib, timeoutMs) parked the
  // event loop for the whole session handshake (full timeoutMs on an absent
  // node). Unlike the sync create, a FAILED async create can still hold a live
  // handle — always destroy non-negative handles (the finally below).
  const { handle: tag, status: createStatus } = await createRawTagAsync(attribStr, timeoutMs)
  if (tag < 0) return null
  try {
    if (createStatus !== PlcTagStatus.PLCTAG_STATUS_OK) return null
    const req = buildIdentityRequest()
    plc_tag_set_size(tag, req.length)
    for (let i = 0; i < req.length; i++) plc_tag_set_uint8(tag, i, req[i])
    // @raw: the WRITE *sends* the CIP request (a read-only Get_Attributes_All);
    // the reply lands back in the tag buffer. Nothing is written to the device.
    const status = await writeTagAsync(tag, timeoutMs)
    if (status !== PlcTagStatus.PLCTAG_STATUS_OK) return null

    const size = plc_tag_get_size(tag)
    if (size <= 0) return null
    const raw = Buffer.alloc(size)
    plc_tag_get_raw_bytes(tag, 0, raw)

    const { identity } = parseIdentityReply(raw)
    return identity
  } catch {
    return null
  } finally {
    try { plc_tag_destroy(tag) } catch { /* best-effort */ }
  }
}
