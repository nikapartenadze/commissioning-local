#!/usr/bin/env tsx
/**
 * SPIKE — read the CIP DLR Object (Class 0x47) off a 1756-EN2TR/EN4TR to
 * confirm whether the comms ring is actually a DLR ring and whether it's
 * closed/healthy. See frontend/specs/2026-05-26-network-ring-health-research.md.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS READ-ONLY. It issues CIP **Get_Attribute_Single (0x0E)** requests,
 * which only READ attributes — nothing is written to the controller or the
 * module. (libplctag's `@raw` tag uses `plc_tag_write` merely to *send* the
 * raw request bytes; the CIP service inside is a read. No PLC tags, no I/O,
 * no pass/fail, no config are modified.)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NOTE (verified 2026-05-26): the dev PLC at 192.168.5.106 is a Studio 5000
 * "Emulate 5580 Safety Controller" (software emulator). It has NO physical
 * chassis / EN4TR / DLR object, so this spike can only print the no-module
 * result there. Run it on-site against a REAL controller whose chassis holds
 * the EN4TR to get a live ring verdict.
 *
 * Usage:
 *   npm run test:plc:dlr
 *   PLC_IP=<controller-ip> PLC_PATH=1,<EN4TR slot> npm run test:plc:dlr
 *
 * Env:
 *   PLC_IP    Ethernet IP to connect to    (default 192.168.5.106)
 *   PLC_PATH  CIP path to the EN4TR module (default 1,2 = backplane, slot 2 = SLOT2_EN4TR)
 *   TIMEOUT   per-request timeout ms       (default 5000)
 */

import {
  initLibrary, plc_tag_create, plc_tag_set_size, plc_tag_set_uint8,
  writeTagAsync, plc_tag_get_size, plc_tag_get_raw_bytes, plc_tag_destroy,
  getStatusMessage, PlcTagStatus,
} from './lib/plc/libplctag'

const PLC_IP = process.env.PLC_IP ?? '192.168.5.106'
const PLC_PATH = process.env.PLC_PATH ?? '1,2'
const TIMEOUT = Number(process.env.TIMEOUT ?? '5000')

const TOPOLOGY = ['Linear', 'Ring'] as const
const NETWORK_STATUS = [
  'Normal', 'Ring Fault', 'Unexpected Loop Detected',
  'Partial Network Fault', 'Rapid Fault/Restore Cycle',
] as const

interface AttrResult {
  /** transport-level (did a CIP reply come back at all) */
  transportOk: boolean
  transportStatus: number
  /** CIP general status byte (0 = success; 0x05 = object/path doesn't exist) */
  cipStatus: number
  /** attribute payload bytes (LE) when cipStatus === 0 */
  value: Buffer
  raw: Buffer
}

/** One Get_Attribute_Single via @raw. Never throws — returns transportOk=false on timeout. */
async function getAttr(path: string, cls: number, inst: number, attr: number): Promise<AttrResult> {
  const empty = Buffer.alloc(0)
  const attribStr = `protocol=ab_eip&gateway=${PLC_IP}&path=${path}&cpu=logix&name=@raw`
  const tag = plc_tag_create(attribStr, TIMEOUT)
  if (tag < 0) return { transportOk: false, transportStatus: tag, cipStatus: -1, value: empty, raw: empty }
  try {
    const req = Uint8Array.from([0x0e, 0x03, 0x20, cls, 0x24, inst, 0x30, attr])
    plc_tag_set_size(tag, req.length)
    for (let i = 0; i < req.length; i++) plc_tag_set_uint8(tag, i, req[i])
    const status = await writeTagAsync(tag, TIMEOUT) // WRITE sends the request; reply lands in the buffer
    if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
      return { transportOk: false, transportStatus: status, cipStatus: -1, value: empty, raw: empty }
    }
    const size = plc_tag_get_size(tag)
    const raw = Buffer.alloc(Math.max(0, size))
    if (size > 0) plc_tag_get_raw_bytes(tag, 0, raw)
    if (raw.length < 4) return { transportOk: true, transportStatus: status, cipStatus: -1, value: empty, raw }
    const cipStatus = raw[2]
    const value = Buffer.from(raw.subarray(4 + 2 * raw[3]))
    return { transportOk: true, transportStatus: status, cipStatus, value, raw }
  } finally {
    try { plc_tag_destroy(tag) } catch { /* best-effort */ }
  }
}

/** CIP SHORT_STRING: 1-byte length + chars. */
function decodeShortString(buf: Buffer): string {
  if (buf.length < 1) return ''
  const len = buf[0]
  return buf.subarray(1, 1 + len).toString('ascii')
}

function fmtEnum(table: readonly string[], n: number): string {
  return `${n} (${table[n] ?? 'unknown'})`
}

async function main() {
  console.log('────────────────────────────────────────────────────────')
  console.log(' DLR Object spike — READ-ONLY (Get_Attribute_Single 0x0E)')
  console.log(`  gateway=${PLC_IP}  path=${PLC_PATH}  class=0x47 inst=1`)
  console.log('────────────────────────────────────────────────────────')
  initLibrary()

  // Identity probe at the target path first — tells us what (if anything)
  // answers there, before we ask for the DLR object.
  const ident = await getAttr(PLC_PATH, 0x01, 1, 7) // Identity, Product Name
  if (!ident.transportOk) {
    console.log(`\n✗ No CIP device responded at gateway=${PLC_IP} path=${PLC_PATH} (${getStatusMessage(ident.transportStatus)}).`)
    console.log('  Likely causes:')
    console.log('   • The controller is a software emulator (Studio 5000 Emulate) — no physical chassis/EN4TR exists.')
    console.log('   • PLC_PATH points at an empty/wrong slot — set PLC_PATH=1,<EN4TR slot>.')
    console.log('   • Wrong gateway IP, or the EN4TR is unreachable.')
    // Show what the gateway controller itself is, for context.
    const ctl = await getAttr('1,0', 0x01, 1, 7)
    if (ctl.transportOk && ctl.cipStatus === 0) {
      console.log(`  (Controller at path 1,0 identifies as: "${decodeShortString(ctl.value)}")`)
    }
    return
  }
  if (ident.cipStatus === 0) {
    console.log(`\nDevice at path ${PLC_PATH}: "${decodeShortString(ident.value)}"`)
  }

  const a1 = await getAttr(PLC_PATH, 0x47, 1, 1)
  if (a1.transportOk && a1.cipStatus === 0x05) {
    console.log('\n✗ This device has no DLR object (CIP status 0x05 = object does not exist).')
    console.log('  The DLR object lives on the Ethernet ring module (EN2TR/EN4TR), not the controller.')
    console.log('  Point PLC_PATH at the EN4TR slot.')
    return
  }
  if (!a1.transportOk || a1.cipStatus !== 0) {
    console.log(`\n✗ DLR Attr 1 read failed (transport=${getStatusMessage(a1.transportStatus)}, cipStatus=0x${a1.cipStatus.toString(16)}).`)
    return
  }

  const a2 = await getAttr(PLC_PATH, 0x47, 1, 2)
  const a5 = await getAttr(PLC_PATH, 0x47, 1, 5)
  const a8 = await getAttr(PLC_PATH, 0x47, 1, 8)

  const topology = a1.value[0]
  const netStatus = a2.value[0]
  const faultCount = a5.transportOk && a5.cipStatus === 0 && a5.value.length >= 2 ? a5.value.readUInt16LE(0) : null
  const participants = a8.transportOk && a8.cipStatus === 0 && a8.value.length >= 2 ? a8.value.readUInt16LE(0) : null

  console.log('\nDLR attributes:')
  console.log(`  Attr 1  Network Topology : ${fmtEnum(TOPOLOGY, topology)}`)
  console.log(`  Attr 2  Network Status   : ${a2.transportOk && a2.cipStatus === 0 ? fmtEnum(NETWORK_STATUS, netStatus) : 'read failed'}`)
  console.log(`  Attr 5  Ring Fault Count : ${faultCount ?? 'n/a'}`)
  console.log(`  Attr 8  Participants     : ${participants ?? 'n/a'}`)

  const healthy = topology === 1 && a2.transportOk && a2.cipStatus === 0 && netStatus === 0
  console.log('\nVerdict:')
  if (topology !== 1) {
    console.log('  ⚠ Topology is LINEAR — this is NOT a DLR ring (redundancy, if any, is in the Hirschmann/MRP layer).')
  } else if (healthy) {
    console.log('  ✓ DLR ring is CLOSED and HEALTHY (Topology=Ring, Network Status=Normal).')
  } else {
    console.log(`  ✗ DLR ring is DEGRADED — Network Status = ${fmtEnum(NETWORK_STATUS, netStatus)} (open/no redundancy).`)
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[dlr-spike] fatal:', err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
