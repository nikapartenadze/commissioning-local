import { describe, it, expect } from 'vitest'
import {
  buildIdentityRequest,
  parseCipReply,
  parseIdentityValue,
  parseIdentityReply,
} from '@/lib/plc/identity/identity-parse'

describe('buildIdentityRequest', () => {
  it('encodes Get_Attributes_All (0x01) for Identity class 0x01, instance 1', () => {
    // [service][path size in WORDS][EPATH class 0x20,0x01][EPATH instance 0x24,0x01]
    expect(Array.from(buildIdentityRequest())).toEqual([0x01, 0x02, 0x20, 0x01, 0x24, 0x01])
  })
})

describe('parseCipReply', () => {
  it('extracts CIP status and the value payload on success', () => {
    // reply_service 0x81, reserved 0, status 0, num_status_words 0, value 0xAA 0xBB
    const r = parseCipReply(Buffer.from([0x81, 0x00, 0x00, 0x00, 0xaa, 0xbb]))
    expect(r.cipStatus).toBe(0)
    expect(Array.from(r.value)).toEqual([0xaa, 0xbb])
  })

  it('reports a non-zero CIP general status', () => {
    const r = parseCipReply(Buffer.from([0x81, 0x00, 0x08, 0x00]))
    expect(r.cipStatus).toBe(0x08)
    expect(r.value.length).toBe(0)
  })

  it('skips extended-status words before the value', () => {
    const r = parseCipReply(Buffer.from([0x81, 0x00, 0x01, 0x01, 0xaa, 0xbb, 0x42]))
    expect(r.cipStatus).toBe(0x01)
    expect(Array.from(r.value)).toEqual([0x42])
  })

  it('treats a too-short buffer as malformed (cipStatus -1)', () => {
    const r = parseCipReply(Buffer.from([0x81, 0x00]))
    expect(r.cipStatus).toBe(-1)
    expect(r.value.length).toBe(0)
  })
})

describe('parseIdentityValue', () => {
  // A realistic 1756-L85E Identity payload:
  //   Vendor ID 1 (Rockwell), Device Type 14 (0x0E), Product Code 166 (0xA6),
  //   Revision 33.11, Status 0x0030, Serial 0x11223344, Product Name "1756-L85E/B"
  const name = '1756-L85E/B'
  const value = Buffer.concat([
    Buffer.from([0x01, 0x00]),             // vendor 1
    Buffer.from([0x0e, 0x00]),             // device type 14
    Buffer.from([0xa6, 0x00]),             // product code 166
    Buffer.from([33, 11]),                 // revision 33.11
    Buffer.from([0x30, 0x00]),             // status 0x0030
    Buffer.from([0x44, 0x33, 0x22, 0x11]), // serial 0x11223344
    Buffer.from([name.length]),            // SHORT_STRING length
    Buffer.from(name, 'latin1'),           // product name chars
  ])

  it('parses every Identity field little-endian', () => {
    const id = parseIdentityValue(value)
    expect(id).not.toBeNull()
    expect(id!.vendorId).toBe(1)
    expect(id!.deviceType).toBe(14)
    expect(id!.productCode).toBe(166)
    expect(id!.revMajor).toBe(33)
    expect(id!.revMinor).toBe(11)
    expect(id!.status).toBe(0x0030)
    expect(id!.serial).toBe(0x11223344)
    expect(id!.productName).toBe('1756-L85E/B')
  })

  it('masks the reserved high bit of major revision (CIP: major is 7 bits)', () => {
    // major byte 0xA1 = 0x80 (reserved bit) | 33 → major should read 33
    const v = Buffer.from(value)
    v[6] = 0x80 | 33
    expect(parseIdentityValue(v)!.revMajor).toBe(33)
  })

  it('tolerates a product name shorter than its declared length (truncated buffer)', () => {
    const v = value.subarray(0, 15 + 4) // only 4 of the name chars present
    const id = parseIdentityValue(v)
    expect(id).not.toBeNull()
    expect(id!.productName).toBe('1756')
  })

  it('returns null when the buffer is too short to hold the fixed fields', () => {
    expect(parseIdentityValue(Buffer.from([0x01, 0x00, 0x0e]))).toBeNull()
  })
})

describe('parseIdentityReply', () => {
  it('returns the identity when the CIP status is success', () => {
    const payload = Buffer.concat([
      Buffer.from([0x01, 0x00, 0x0e, 0x00, 0xa6, 0x00, 20, 5, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ])
    const raw = Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x00]), payload])
    const { cipStatus, identity } = parseIdentityReply(raw)
    expect(cipStatus).toBe(0)
    expect(identity!.revMajor).toBe(20)
    expect(identity!.revMinor).toBe(5)
  })

  it('returns no identity on a CIP error status', () => {
    const raw = Buffer.from([0x81, 0x00, 0x05, 0x00]) // 0x05 = path destination unknown
    const { cipStatus, identity } = parseIdentityReply(raw)
    expect(cipStatus).toBe(0x05)
    expect(identity).toBeNull()
  })
})
