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
 * Usage:
 *   npm run test:plc:dlr
 *   PLC_IP=192.168.5.106 PLC_PATH=1,2 npm run test:plc:dlr
 *
 * Env:
 *   PLC_IP    Ethernet IP to connect to        (default 192.168.5.106)
 *   PLC_PATH  CIP path to the EN4TR module      (default 1,2 = backplane, slot 2 = SLOT2_EN4TR)
 *             - Option A (default): gateway=<controller IP>, path=1,<EN4TR slot>
 *             - Option B: gateway=<EN4TR's own IP>, path=1,0
 *   TIMEOUT   per-request timeout ms            (default 5000)
 *
 * The DLR object lives on the Ethernet *module* (the ring supervisor), NOT the
 * controller — so PLC_PATH must end at the EN4TR's slot, not slot 0.
 */

import {
  initLibrary,
  plc_tag_create,
  plc_tag_set_size,
  plc_tag_set_uint8,
  writeTagAsync,
  plc_tag_get_size,
  plc_tag_get_raw_bytes,
  plc_tag_destroy,
  getStatusMessage,
  PlcTagStatus,
} from './lib/plc/libplctag'

const PLC_IP = process.env.PLC_IP ?? '192.168.5.106'
const PLC_PATH = process.env.PLC_PATH ?? '1,2'
const TIMEOUT = Number(process.env.TIMEOUT ?? '5000')

const DLR_CLASS = 0x47 // DLR Object
const DLR_INSTANCE = 0x01

// Human-readable DLR enums (ODVA DLR Object; see the research doc).
const TOPOLOGY = ['Linear', 'Ring'] as const
const NETWORK_STATUS = [
  'Normal',
  'Ring Fault',
  'Unexpected Loop Detected',
  'Partial Network Fault',
  'Rapid Fault/Restore Cycle',
] as const

/** Build a Get_Attribute_Single (0x0E) raw-CIP request for DLR class/inst/attr. */
function buildGetAttrSingle(attr: number): Uint8Array {
  // [service][path size in 16-bit WORDS][EPATH: class, inst, attr][no data]
  // EPATH = 20 47 24 01 30 <attr>  => 6 bytes = 3 words
  return Uint8Array.from([0x0e, 0x03, 0x20, DLR_CLASS, 0x24, DLR_INSTANCE, 0x30, attr])
}

interface AttrResult {
  ok: boolean
  cipStatus: number
  /** raw value bytes (little-endian) after the CIP reply header, when ok */
  value: Buffer
  raw: Buffer
}

/**
 * Send one Get_Attribute_Single and return the parsed reply.
 * @raw reply layout: [0]=reply_service(0x8E) [1]=0 [2]=general status
 * [3]=num extended-status words [4 + 2*words ...]=attribute payload.
 */
async function readAttr(attr: number): Promise<AttrResult> {
  const attribStr = `protocol=ab_eip&gateway=${PLC_IP}&path=${PLC_PATH}&cpu=logix&name=@raw`
  const tag = plc_tag_create(attribStr, TIMEOUT)
  if (tag < 0) {
    return { ok: false, cipStatus: -1, value: Buffer.alloc(0), raw: Buffer.alloc(0) }
  }
  try {
    const req = buildGetAttrSingle(attr)
    plc_tag_set_size(tag, req.length)
    for (let i = 0; i < req.length; i++) plc_tag_set_uint8(tag, i, req[i])

    const status = await writeTagAsync(tag, TIMEOUT) // WRITE sends the request; reply lands in the buffer
    if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
      throw new Error(`transport: ${getStatusMessage(status)} (${status})`)
    }

    const size = plc_tag_get_size(tag)
    const raw = Buffer.alloc(Math.max(0, size))
    if (size > 0) plc_tag_get_raw_bytes(tag, 0, raw)

    if (raw.length < 4) return { ok: false, cipStatus: -1, value: Buffer.alloc(0), raw }
    const cipStatus = raw[2]
    const numStatusWords = raw[3]
    const valueOffset = 4 + 2 * numStatusWords
    const value = raw.subarray(valueOffset)
    return { ok: cipStatus === 0, cipStatus, value: Buffer.from(value), raw }
  } finally {
    try { plc_tag_destroy(tag) } catch { /* best-effort */ }
  }
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

  // Attr 1 = Network Topology (USINT), Attr 2 = Network Status (USINT),
  // Attr 5 = Ring Fault Count (UINT), Attr 8 = Ring Participants Count (UINT).
  const a1 = await readAttr(1)
  const a2 = await readAttr(2)
  const a5 = await readAttr(5)
  const a8 = await readAttr(8)

  if (!a1.ok && a1.cipStatus !== 0) {
    console.log(`\n✗ Attr 1 read failed (CIP status 0x${a1.cipStatus.toString(16)}). raw=[${a1.raw.toString('hex')}]`)
    console.log('  → This device may not implement the DLR object at this path.')
    console.log('    Check PLC_PATH points at the EN4TR slot (e.g. 1,2), not the controller (1,0).')
    return
  }

  const topology = a1.value[0]
  const netStatus = a2.value[0]
  const faultCount = a5.ok && a5.value.length >= 2 ? a5.value.readUInt16LE(0) : null
  const participants = a8.ok && a8.value.length >= 2 ? a8.value.readUInt16LE(0) : null

  console.log('\nDLR attributes:')
  console.log(`  Attr 1  Network Topology : ${fmtEnum(TOPOLOGY, topology)}`)
  console.log(`  Attr 2  Network Status   : ${a2.ok ? fmtEnum(NETWORK_STATUS, netStatus) : `read failed (0x${a2.cipStatus.toString(16)})`}`)
  console.log(`  Attr 5  Ring Fault Count : ${faultCount ?? 'n/a'}`)
  console.log(`  Attr 8  Participants     : ${participants ?? 'n/a'}`)

  const healthy = topology === 1 && a2.ok && netStatus === 0
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
