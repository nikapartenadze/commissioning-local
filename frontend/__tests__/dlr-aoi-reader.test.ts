/**
 * Integration tests for the DLR AOI reader (lib/plc/network/dlr-aoi-reader.ts).
 *
 * No hardware: `readTypedTagsForMcm` from @/lib/mcm-registry is mocked, so these
 * exercise the real batching, SINT normalisation, per-tag failure handling and
 * never-throws contract against controlled fixtures.
 *
 * The pure decode (./dlr-aoi.ts) is covered by __tests__/dlr-aoi.test.ts and is
 * deliberately NOT retested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  /** Set per test: what the single batch call resolves to (or throws). */
  batch: null as any,
  throwErr: null as any,
  calls: [] as any[][],
}))

vi.mock('@/lib/mcm-registry', () => ({
  readTypedTagsForMcm: vi.fn(async (subsystemId: string, reads: any[]) => {
    state.calls.push(reads)
    if (state.throwErr) throw state.throwErr
    return state.batch
  }),
}))

import { readDlrAoiForMcm } from '@/lib/plc/network/dlr-aoi-reader'
import { readTypedTagsForMcm } from '@/lib/mcm-registry'

const BASE = 'MCM08_SLOT2_EN4TR'
const T_STATUS = `${BASE}.AOI.DLR_Break_Present`
const T_COMM = `${BASE}.AOI.Communication_Faulted`
const P1 = (i: number) => `${BASE}.HMI.DLR_Break_Point1_Data[${i}]`
const P2 = (i: number) => `${BASE}.HMI.DLR_Break_Point2_Data[${i}]`

/** A break-point node: 4 B IPv4 + 6 B MAC. */
const NODE_A = [192, 168, 5, 10, 0x00, 0x1d, 0x9c, 0x11, 0x22, 0x33]
const NODE_B = [192, 168, 5, 11, 0x00, 0x1d, 0x9c, 0x11, 0x22, 0x34]

/**
 * Build a connected batch result. `opts.point1Len`/`point2Len` truncate how many
 * of the 10 array elements come back successful (the rest report a read error).
 */
function makeBatch(opts: {
  status?: number | null
  comm?: boolean | number | null
  point1?: number[]
  point2?: number[]
  point1Len?: number
  point2Len?: number
  connected?: boolean
} = {}) {
  const {
    status = 0,
    comm = false,
    point1 = new Array(10).fill(0),
    point2 = new Array(10).fill(0),
    point1Len = 10,
    point2Len = 10,
    connected = true,
  } = opts

  const results: any[] = []
  results.push(
    status === null
      ? { name: T_STATUS, success: false, error: 'tag not found' }
      : { name: T_STATUS, success: true, value: status },
  )
  results.push(
    comm === null
      ? { name: T_COMM, success: false, error: 'tag not found' }
      : { name: T_COMM, success: true, value: comm },
  )
  for (let i = 0; i < 10; i++) {
    results.push(
      i < point1Len
        ? { name: P1(i), success: true, value: point1[i] }
        : { name: P1(i), success: false, error: 'element read failed' },
    )
  }
  for (let i = 0; i < 10; i++) {
    results.push(
      i < point2Len
        ? { name: P2(i), success: true, value: point2[i] }
        : { name: P2(i), success: false, error: 'element read failed' },
    )
  }
  return { connected, results }
}

beforeEach(() => {
  state.batch = makeBatch()
  state.throwErr = null
  state.calls = []
  vi.mocked(readTypedTagsForMcm).mockClear()
})

describe('readDlrAoiForMcm — happy path', () => {
  it('assembles a DlrAoiReading from 22 successful reads', async () => {
    state.batch = makeBatch({ status: 1, comm: false, point1: NODE_A, point2: NODE_B })

    const out = await readDlrAoiForMcm('47', BASE)

    expect(out.ok).toBe(true)
    expect(out.reading).toEqual({
      breakPresent: 1,
      communicationFaulted: false,
      point1: NODE_A,
      point2: NODE_B,
    })
  })

  it('returns point1/point2 as 10-element arrays in [0]..[9] order', async () => {
    // Deliberately distinct, order-sensitive payloads.
    const p1 = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const p2 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]
    state.batch = makeBatch({ status: 1, point1: p1, point2: p2 })

    const out = await readDlrAoiForMcm('47', BASE)

    expect(out.reading!.point1).toHaveLength(10)
    expect(out.reading!.point2).toHaveLength(10)
    expect(out.reading!.point1).toEqual(p1)
    expect(out.reading!.point2).toEqual(p2)
  })

  it('reports communicationFaulted true when the BOOL reads true', async () => {
    state.batch = makeBatch({ status: 0, comm: true })
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.ok).toBe(true)
    expect(out.reading!.communicationFaulted).toBe(true)
  })

  it('accepts a numeric 1 from the BOOL read as true', async () => {
    state.batch = makeBatch({ status: 0, comm: 1 })
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.reading!.communicationFaulted).toBe(true)
  })
})

describe('readDlrAoiForMcm — batching', () => {
  it('issues EXACTLY ONE batch call carrying all 22 tag reads (not 22 round trips)', async () => {
    await readDlrAoiForMcm('47', BASE)

    expect(vi.mocked(readTypedTagsForMcm)).toHaveBeenCalledTimes(1)
    expect(state.calls).toHaveLength(1)

    const reads = state.calls[0]
    expect(reads).toHaveLength(22)
    const names = reads.map((r: any) => r.name)
    expect(names[0]).toBe(T_STATUS)
    expect(names[1]).toBe(T_COMM)
    for (let i = 0; i < 10; i++) expect(names[2 + i]).toBe(P1(i))
    for (let i = 0; i < 10; i++) expect(names[12 + i]).toBe(P2(i))
    // Array elements must be addressed individually, never as a bare `Tag[0]` ×10.
    expect(new Set(names).size).toBe(22)
  })

  /**
   * The byte tags MUST be read as 'SINT' — a 1-byte element decoded with
   * plc_tag_get_uint8. The two wrong choices are each dangerous in their own way:
   *
   *   'INT'  asks for a 2-byte element on a 1-byte tag. If libplctag accepts it
   *          and the bounds-checked getter returns 0, the masked byte is 0 —
   *          which decodes as status 0 "Normal", a FABRICATED HEALTHY RING.
   *   'BOOL' decodes via plc_tag_get_bit(handle, 0) — bit 0 only, which is
   *          exactly the DLR_Broken bit-0 bug dlr-aoi.ts exists to correct
   *          (status 2 "Unexpected Loop Detected" would read as healthy).
   *
   * Both failure modes report a broken ring as fine, so this assertion is a
   * safety guard, not a style preference.
   */
  it('reads the byte tags as SINT — never INT (false-healthy) or BOOL (bit-0 read)', async () => {
    await readDlrAoiForMcm('47', BASE)
    const reads = state.calls[0]
    expect(reads.find((r: any) => r.name === T_STATUS).dataType).toBe('SINT')
    expect(reads.find((r: any) => r.name === T_COMM).dataType).toBe('BOOL')
    for (let i = 0; i < 10; i++) {
      expect(reads.find((r: any) => r.name === P1(i)).dataType).toBe('SINT')
      expect(reads.find((r: any) => r.name === P2(i)).dataType).toBe('SINT')
    }
  })
})

describe('readDlrAoiForMcm — breakPresent null vs 0', () => {
  /**
   * THIS DISTINCTION MATTERS ENORMOUSLY.
   *
   * On this tag 0 is a REAL value meaning "Normal / ring closed", and null means
   * "we could not read it". If a failed read were defaulted to 0, a ring we
   * cannot see would be reported as a HEALTHY ring — a broken ring silently
   * shown as fine. breakPresent must therefore be null, never 0, when the
   * DLR_Break_Present read fails.
   *
   * Communication_Faulted is set true here only so the reader returns a reading
   * to inspect (with it false, a failed status read is an ok:false result —
   * covered separately below). The assertion under test is the null-ness.
   */
  it('is null (NOT 0) when the DLR_Break_Present read fails', async () => {
    state.batch = makeBatch({ status: null, comm: true })

    const out = await readDlrAoiForMcm('47', BASE)

    expect(out.ok).toBe(true)
    expect(out.reading!.breakPresent).toBeNull()
    expect(out.reading!.breakPresent).not.toBe(0)
  })

  it('is 0 (NOT null) when the tag genuinely reads Normal', async () => {
    state.batch = makeBatch({ status: 0 })
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.reading!.breakPresent).toBe(0)
    expect(out.reading!.breakPresent).not.toBeNull()
  })

  it('does not launder a failed Communication_Faulted read into "module faulted"', async () => {
    // A failed comms read must report false, not true — otherwise a real ring
    // fault would hide behind a fabricated comms excuse.
    state.batch = makeBatch({ status: 1, comm: null })
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.ok).toBe(true)
    expect(out.reading!.communicationFaulted).toBe(false)
    expect(out.reading!.breakPresent).toBe(1)
  })
})

describe('readDlrAoiForMcm — signed SINT normalisation', () => {
  it('normalises a signed status byte: -1 becomes 255', async () => {
    state.batch = makeBatch({ status: -1 })
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.reading!.breakPresent).toBe(255)
  })

  it('normalises a signed status byte: -56 becomes 200', async () => {
    state.batch = makeBatch({ status: -56 })
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.reading!.breakPresent).toBe(200)
  })

  it('normalises every signed byte of both break-point arrays', async () => {
    const signed = [-1, -56, -128, 1, -1, -56, 0, 127, -2, -3]
    const unsigned = [255, 200, 128, 1, 255, 200, 0, 127, 254, 253]
    state.batch = makeBatch({ status: 1, point1: signed, point2: signed })

    const out = await readDlrAoiForMcm('47', BASE)

    expect(out.reading!.point1).toEqual(unsigned)
    expect(out.reading!.point2).toEqual(unsigned)
    expect(out.reading!.point1.every((b: number) => b >= 0 && b <= 255)).toBe(true)
  })
})

describe('readDlrAoiForMcm — partial break-point arrays', () => {
  it('drops a partially-read array entirely rather than handing the decoder a truncated value', async () => {
    // Only 6 of the 10 elements of point1 read cleanly. A truncated array would
    // decode to a plausible-but-WRONG IP/MAC; reporting no localization at all
    // is strictly better than reporting a fabricated node.
    state.batch = makeBatch({ status: 1, point1: NODE_A, point1Len: 6, point2: NODE_B })

    const out = await readDlrAoiForMcm('47', BASE)

    expect(out.ok).toBe(true)
    expect(out.reading!.point1).toEqual([])
    expect(out.reading!.point1).not.toHaveLength(6)
    // The intact array is unaffected.
    expect(out.reading!.point2).toEqual(NODE_B)
  })

  it('drops the array when a single middle element fails', async () => {
    const batch = makeBatch({ status: 1, point1: NODE_A })
    // Fail only element [4] — the first MAC byte.
    const bad = batch.results.find((r: any) => r.name === P1(4))
    bad.success = false
    delete bad.value
    bad.error = 'element read failed'
    state.batch = batch

    const out = await readDlrAoiForMcm('47', BASE)

    expect(out.reading!.point1).toEqual([])
  })

  it('leaves both arrays empty when neither array read at all', async () => {
    state.batch = makeBatch({ status: 1, point1Len: 0, point2Len: 0 })
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.reading!.point1).toEqual([])
    expect(out.reading!.point2).toEqual([])
  })
})

describe('readDlrAoiForMcm — failure paths', () => {
  it('returns {ok:false, reason} with a human-readable reason when the controller is disconnected', async () => {
    state.batch = { connected: false, results: [] }

    const out = await readDlrAoiForMcm('47', BASE)

    expect(out.ok).toBe(false)
    expect(typeof out.reason).toBe('string')
    expect(out.reason!.length).toBeGreaterThan(0)
    expect(out.reason).toMatch(/not connected/i)
    expect(out.reading).toBeUndefined()
  })

  it('returns {ok:false, reason} when the whole batch comes back with every read failed', async () => {
    state.batch = makeBatch({ status: null, comm: null, point1Len: 0, point2Len: 0 })

    const out = await readDlrAoiForMcm('47', BASE)

    expect(out.ok).toBe(false)
    expect(out.reason!.length).toBeGreaterThan(0)
    expect(out.reason).toMatch(/AOI_RACK_NETWORK_NODE/)
  })

  it('DOES NOT THROW when the underlying read rejects — it returns {ok:false}', async () => {
    state.throwErr = new Error('libplctag: os error 126')

    // The whole point: a PLC-layer explosion must never propagate to the caller.
    await expect(readDlrAoiForMcm('47', BASE)).resolves.toBeDefined()

    state.throwErr = new Error('libplctag: os error 126')
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/os error 126/)
  })

  it('does not throw when the read rejects with a non-Error value', async () => {
    state.throwErr = 'gateway unreachable'
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/gateway unreachable/)
  })

  it('does not throw when the batch resolves to null/undefined', async () => {
    state.batch = null
    const out = await readDlrAoiForMcm('47', BASE)
    expect(out.ok).toBe(false)
    expect(out.reason!.length).toBeGreaterThan(0)
  })

  it('rejects a missing subsystemId or base without ever touching the PLC layer', async () => {
    const noSid = await readDlrAoiForMcm('', BASE)
    expect(noSid.ok).toBe(false)
    expect(noSid.reason!.length).toBeGreaterThan(0)

    const noBase = await readDlrAoiForMcm('47', '')
    expect(noBase.ok).toBe(false)
    expect(noBase.reason!.length).toBeGreaterThan(0)

    expect(vi.mocked(readTypedTagsForMcm)).not.toHaveBeenCalled()
  })
})
