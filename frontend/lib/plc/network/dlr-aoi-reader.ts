/**
 * On-demand reader for the PLC-side DLR AOI tags (`AOI_RACK_NETWORK_NODE`).
 *
 * READ ONLY, ON DEMAND. The AOI self-polls the CIP DLR object (class 0x47)
 * every 500 ms from its own internal TON, so there is nothing to trigger and
 * nothing to write: writing a MESSAGE tag does NOT execute a MSG in Logix.
 * This module opens no loop and no timer — one batch read per call.
 *
 * Decoding lives entirely in ./dlr-aoi.ts (pure, unit-tested). This module is
 * only the I/O seam: build the tag names, issue one mode-aware batch read via
 * readTypedTagsForMcm (embedded in-process / remote via the plc-gateway), and
 * assemble a DlrAoiReading.
 *
 * ── SINT over the typed-read API (read this before "fixing" the types) ──────
 * The byte tags are read as 'SINT' (PlcReadType in lib/plc/plc-client.ts),
 * which uses a 1-byte element and decodes via plc_tag_get_uint8 — a clean
 * 0-255, matching the API contract (`breakPresent` = raw status byte).
 *
 *   1. There is no array read: the API reads exactly ONE element per entry.
 *      The two Break_Point tags are SINT[10], so they are requested as ten
 *      explicit `[0]`..`[9]` element reads. They still go out in ONE batch call
 *      together with the two scalars (22 entries), so the controller sees a
 *      single burst, not 22 round trips.
 *   2. Do NOT "simplify" these to 'INT'. An INT asks for a 2-byte element on a
 *      1-byte tag; if libplctag accepts it and the bounds-checked getter returns
 *      0, the masked byte is 0 — which decodes as status 0 "Normal", i.e. a
 *      FABRICATED HEALTHY RING. That is the exact failure this module must never
 *      produce. SINT removes the ambiguity.
 *   3. Do NOT switch these to 'BOOL' either: the BOOL decoder is
 *      plc_tag_get_bit(handle, 0), i.e. bit 0 only — precisely the DLR_Broken
 *      bit-0 bug that ./dlr-aoi.ts exists to correct (it would call status 2
 *      "Unexpected Loop Detected" healthy).
 *
 * SINT is deliberately absent from the WRITE type union, so none of this can
 * leak into a write path. Reads only.
 *
 * `<base>.AOI.DLR_Broken` is ExternalAccess="None" and is never referenced.
 */

import { readTypedTagsForMcm, type TypedTagRead } from '@/lib/mcm-registry'
import { dlrTagNames, type DlrAoiReading } from './dlr-aoi'

/** Elements in each `DLR_Break_Point<n>_Data` SINT array: 4 B IPv4 + 6 B MAC. */
const BREAK_POINT_BYTES = 10

/**
 * Flat result shape on purpose — tsconfig.server.json runs with strict:false,
 * where discriminated-union narrowing on an `if (!x.ok)` negative branch does
 * not hold and callers would fail the build.
 */
export interface DlrAoiReadResult {
  ok: boolean
  reading?: DlrAoiReading
  reason?: string
}

/** Mask a typed-read result down to the SINT byte the controller actually holds. */
function toByte(value: number | boolean | undefined): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return ((Math.trunc(value) % 256) + 256) % 256
}

/** Replace `Tag[0]` with `Tag[i]`. The names from dlrTagNames() already end in `[0]`. */
function elementName(base0: string, index: number): string {
  return base0.replace(/\[0\]$/, `[${index}]`)
}

/**
 * Read the four DLR AOI tags for one MCM in a single batch.
 *
 * NEVER THROWS. Every failure path — unknown MCM, disconnected controller,
 * missing tags, an exception from the PLC layer — comes back as
 * `{ ok: false, reason }` with a message fit to show an operator.
 *
 * `breakPresent` is null (not 0) whenever that specific read failed: 0 is a
 * real, meaningful value on this tag ("Normal"), so conflating the two would
 * report a ring we could not read as a healthy ring.
 */
export async function readDlrAoiForMcm(
  subsystemId: string,
  base: string,
): Promise<DlrAoiReadResult> {
  if (!subsystemId) return { ok: false, reason: 'No subsystemId supplied.' }
  if (!base) return { ok: false, reason: 'No DLR AOI tag base supplied.' }

  const names = dlrTagNames(base)

  // One batch: 2 scalars + 2 × 10 array elements.
  const reads: TypedTagRead[] = [
    // SINT read as INT — see the SINT note in the module header.
    { name: names.breakPresent, dataType: 'SINT' },
    { name: names.commFaulted, dataType: 'BOOL' },
  ]
  for (let i = 0; i < BREAK_POINT_BYTES; i++) {
    reads.push({ name: elementName(names.point1, i), dataType: 'SINT' })
  }
  for (let i = 0; i < BREAK_POINT_BYTES; i++) {
    reads.push({ name: elementName(names.point2, i), dataType: 'SINT' })
  }

  let batch: Awaited<ReturnType<typeof readTypedTagsForMcm>>
  try {
    batch = await readTypedTagsForMcm(subsystemId, reads)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `Reading the DLR AOI tags failed: ${message}` }
  }

  if (!batch || !batch.connected) {
    return {
      ok: false,
      reason: `MCM ${subsystemId} is not connected to its PLC — cannot read the DLR AOI tags.`,
    }
  }

  const results = Array.isArray(batch.results) ? batch.results : []
  const byName = new Map<string, { success: boolean; value?: number | boolean; error?: string }>()
  for (const r of results) {
    if (r && typeof r.name === 'string') byName.set(r.name, r)
  }

  const statusRead = byName.get(names.breakPresent)
  const commRead = byName.get(names.commFaulted)

  // The status tag is the one read we cannot do without: with it unread there
  // is no ring verdict to give, only 'unknown'. null (never 0) carries that.
  const breakPresent =
    statusRead && statusRead.success ? toByte(statusRead.value) : null

  // A failed Communication_Faulted read must not be laundered into "module is
  // faulted" — that would mask a real ring fault behind a comms excuse. Absent
  // evidence of a fault we report false and let breakPresent drive the verdict.
  const communicationFaulted =
    commRead && commRead.success ? commRead.value === true || commRead.value === 1 : false

  // Only hand a break-point array to the decoder when EVERY one of its 10 bytes
  // read cleanly. A partially-read array would decode to a plausible-looking
  // but wrong IP/MAC, which is worse than reporting no localization at all —
  // parseBreakNode() treats a short array as "nothing to report".
  const collect = (point0: string): number[] => {
    const bytes: number[] = []
    for (let i = 0; i < BREAK_POINT_BYTES; i++) {
      const r = byName.get(elementName(point0, i))
      if (!r || !r.success) return []
      bytes.push(toByte(r.value))
    }
    return bytes
  }

  const reading: DlrAoiReading = {
    breakPresent,
    communicationFaulted,
    point1: collect(names.point1),
    point2: collect(names.point2),
  }

  // Nothing at all came back — the AOI almost certainly isn't in this program.
  if (breakPresent === null && !communicationFaulted) {
    const err = statusRead?.error
    if (!statusRead || !statusRead.success) {
      return {
        ok: false,
        reason:
          `Could not read ${names.breakPresent}` +
          (err ? `: ${err}` : '') +
          ' — the rack Ethernet module may not run AOI_RACK_NETWORK_NODE.',
      }
    }
  }

  return { ok: true, reading }
}
