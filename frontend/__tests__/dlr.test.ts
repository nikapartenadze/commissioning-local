import { describe, it, expect } from 'vitest'
import {
  buildDlrRequest,
  parseDlrReply,
  parseRingNodeIp,
  ringVerdict,
  deriveDlrPath,
  type DlrStatus,
} from '@/lib/plc/network/dlr'

describe('buildDlrRequest', () => {
  it('encodes Get_Attribute_Single for DLR class 0x47, instance 1, the given attr', () => {
    expect(Array.from(buildDlrRequest(1))).toEqual([0x0e, 0x03, 0x20, 0x47, 0x24, 0x01, 0x30, 0x01])
    expect(Array.from(buildDlrRequest(2))).toEqual([0x0e, 0x03, 0x20, 0x47, 0x24, 0x01, 0x30, 0x02])
    expect(Array.from(buildDlrRequest(8))).toEqual([0x0e, 0x03, 0x20, 0x47, 0x24, 0x01, 0x30, 0x08])
  })
})

describe('parseDlrReply', () => {
  it('extracts CIP status and the value payload on success', () => {
    // reply_service 0x8E, reserved 0, status 0, num_status_words 0, value 0x01
    const r = parseDlrReply(Buffer.from([0x8e, 0x00, 0x00, 0x00, 0x01]))
    expect(r.cipStatus).toBe(0)
    expect(Array.from(r.value)).toEqual([0x01])
  })

  it('reports a non-zero CIP general status (object does not exist = 0x05)', () => {
    const r = parseDlrReply(Buffer.from([0x8e, 0x00, 0x05, 0x00]))
    expect(r.cipStatus).toBe(0x05)
    expect(r.value.length).toBe(0)
  })

  it('skips extended-status words before the value', () => {
    // status 0x01, num_status_words 1 (2 bytes AA BB), then value 0x42
    const r = parseDlrReply(Buffer.from([0x8e, 0x00, 0x01, 0x01, 0xaa, 0xbb, 0x42]))
    expect(r.cipStatus).toBe(0x01)
    expect(Array.from(r.value)).toEqual([0x42])
  })

  it('treats a too-short buffer as malformed (cipStatus -1)', () => {
    const r = parseDlrReply(Buffer.from([0x8e, 0x00]))
    expect(r.cipStatus).toBe(-1)
    expect(r.value.length).toBe(0)
  })
})

describe('parseRingNodeIp', () => {
  it('reads the 4-byte IP from a Last Active Node struct (IP + MAC)', () => {
    // IP 192.168.5.10 then a 6-byte MAC
    const buf = Buffer.from([192, 168, 5, 10, 0x00, 0x1d, 0x9c, 0x11, 0x22, 0x33])
    expect(parseRingNodeIp(buf)).toBe('192.168.5.10')
  })

  it('returns null for an all-zero node (no break localized / not populated)', () => {
    expect(parseRingNodeIp(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })

  it('returns null for a too-short buffer', () => {
    expect(parseRingNodeIp(Buffer.from([1, 2]))).toBeNull()
  })
})

describe('ringVerdict', () => {
  const base: DlrStatus = {
    topology: 1, networkStatus: 0, faultCount: 0, participants: 5,
    lastActiveNode1: null, lastActiveNode2: null,
  }

  it('is unknown when there is no DLR reading', () => {
    expect(ringVerdict(null).state).toBe('unknown')
  })

  it('is healthy when topology is Ring and status is Normal', () => {
    const v = ringVerdict(base)
    expect(v.state).toBe('healthy')
  })

  it('is degraded with the reason when topology is Ring but status is not Normal', () => {
    expect(ringVerdict({ ...base, networkStatus: 1 })).toMatchObject({ state: 'degraded' })
    expect(ringVerdict({ ...base, networkStatus: 1 }).reason).toMatch(/Ring Fault/i)
    expect(ringVerdict({ ...base, networkStatus: 3 }).reason).toMatch(/Partial/i)
  })

  it('is unknown (not degraded) when topology is Linear — it is not a DLR ring', () => {
    const v = ringVerdict({ ...base, topology: 0 })
    expect(v.state).toBe('unknown')
    expect(v.reason).toMatch(/linear/i)
  })

  it('carries the raw attribute values through for display', () => {
    const v = ringVerdict({ ...base, faultCount: 2, participants: 7 })
    expect(v.faultCount).toBe(2)
    expect(v.participants).toBe(7)
  })

  it('carries the break location (Last Active Node 1/2) on a degraded ring', () => {
    const v = ringVerdict({ ...base, networkStatus: 1, lastActiveNode1: '192.168.5.10', lastActiveNode2: '192.168.5.11' })
    expect(v.state).toBe('degraded')
    expect(v.lastActiveNode1).toBe('192.168.5.10')
    expect(v.lastActiveNode2).toBe('192.168.5.11')
  })
})

describe('deriveDlrPath', () => {
  it('builds the backplane path from a SLOTn_EN4TR/EN2TR device tag name', () => {
    expect(deriveDlrPath(['SLOT2_EN4TR_NN', 'UL27_10_VFD_NN'])).toBe('1,2')
    expect(deriveDlrPath(['UL29_8_DPM1_NN', 'SLOT3_EN2TR_NN'])).toBe('1,3')
  })

  it('returns undefined when no SLOTn_ENxTR device is present', () => {
    expect(deriveDlrPath(['UL27_10_VFD_NN', 'UL29_8_DPM1_NN'])).toBeUndefined()
    expect(deriveDlrPath([])).toBeUndefined()
  })
})
