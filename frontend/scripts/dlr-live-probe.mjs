// Read-only DLR / identity probe for ring-commissioning field verification.
// Uses the tool's own plctag.dll via ffi-rs. NO WRITES — every CIP request sent
// is Get_Attribute_Single (0x0E). The @raw "write" only transports the request;
// nothing is written to the device (same mechanism as lib/plc/network/dlr.ts).
//
//   node scripts/dlr-live-probe.mjs [gateway]
import { open, load, DataType } from 'ffi-rs'

const DLL = new URL('../plctag.dll', import.meta.url).pathname.replace(/^\//, '')
const GW = process.argv[2] || process.env.PLC_GW || '192.168.20.40'
const PATHS = (process.env.PLC_PATHS || '0,1|1,0|1,1|1,2|1,3|<none>').split('|')
const TIMEOUT = 2000

open({ library: 'plctag', path: DLL })
const L = (funcName, retType, paramsType, paramsValue) =>
  load({ library: 'plctag', funcName, retType, paramsType, paramsValue })

const tagCreate = (attr, t) => L('plc_tag_create', DataType.I32, [DataType.String, DataType.I32], [attr, t])
const tagWrite  = (h, t)    => L('plc_tag_write',  DataType.I32, [DataType.I32, DataType.I32], [h, t])
const setSize   = (h, n)    => L('plc_tag_set_size', DataType.I32, [DataType.I32, DataType.I32], [h, n])
const getSize   = (h)       => L('plc_tag_get_size', DataType.I32, [DataType.I32], [h])
const setU8     = (h, o, v) => L('plc_tag_set_uint8', DataType.I32, [DataType.I32, DataType.I32, DataType.I32], [h, o, v])
const getU8     = (h, o)    => L('plc_tag_get_uint8', DataType.I32, [DataType.I32, DataType.I32], [h, o])
const destroy   = (h)       => L('plc_tag_destroy', DataType.I32, [DataType.I32], [h])

const DLR_CLASS = 0x47
const NETWORK_STATUS = ['Normal', 'Ring Fault', 'Unexpected Loop Detected',
                        'Partial Network Fault', 'Rapid Fault/Restore Cycle']

/** Get_Attribute_Single request: [service][path words][EPATH class, inst, attr] */
function buildReq(cls, inst, attr) {
  return [0x0e, 0x03, 0x20, cls, 0x24, inst, 0x30, attr]
}

/** Send one Get_Attribute_Single via @raw. Returns {transportOk, cipStatus, value:[bytes]} */
function cipGet(gw, path, cls, inst, attr) {
  const attrStr = path === '<none>'
    ? `protocol=ab_eip&gateway=${gw}&cpu=logix&name=@raw`
    : `protocol=ab_eip&gateway=${gw}&path=${path}&cpu=logix&name=@raw`
  const h = tagCreate(attrStr, TIMEOUT)
  if (h < 0) return { transportOk: false, cipStatus: -1, value: [], err: `create=${h}` }
  try {
    const req = buildReq(cls, inst, attr)
    setSize(h, req.length)
    req.forEach((b, i) => setU8(h, i, b))
    const st = tagWrite(h, TIMEOUT)
    if (st !== 0) return { transportOk: false, cipStatus: -1, value: [], err: `write=${st}` }
    const size = getSize(h)
    const raw = []
    for (let i = 0; i < size; i++) raw.push(getU8(h, i) & 0xff)
    if (raw.length < 4) return { transportOk: true, cipStatus: -1, value: [], err: 'short reply' }
    const cipStatus = raw[2]
    const numStatusWords = raw[3]
    return { transportOk: true, cipStatus, value: raw.slice(4 + 2 * numStatusWords) }
  } finally {
    try { destroy(h) } catch { /* best-effort */ }
  }
}

const u16 = (v) => (v.length >= 2 ? v[0] | (v[1] << 8) : null)
const shortStr = (v) => (v.length >= 1 ? String.fromCharCode(...v.slice(1, 1 + v[0])) : '')
const ipOf = (v) => (v.length >= 4 && (v[0] | v[1] | v[2] | v[3]) ? `${v[0]}.${v[1]}.${v[2]}.${v[3]}` : null)

console.log(`\n=== DLR / identity probe — gateway ${GW} ===`)
console.log(`Read-only (Get_Attribute_Single only). Paths tried: ${PATHS.join('  ')}\n`)

for (const path of PATHS) {
  const label = path === '<none>' ? '(no path)' : `path=${path}`
  process.stdout.write(`--- ${label} `.padEnd(24, '-') + '\n')

  // 1. Identity object (class 0x01) attr 7 = Product Name — proves who answers.
  const name = cipGet(GW, path, 0x01, 1, 7)
  if (!name.transportOk) {
    console.log(`    identity : UNREACHABLE (${name.err})`)
    continue
  }
  if (name.cipStatus !== 0) {
    console.log(`    identity : CIP status 0x${name.cipStatus.toString(16)}`)
  } else {
    console.log(`    identity : "${shortStr(name.value)}"`)
  }

  // 2. DLR object (class 0x47) attr 1 = Topology, attr 2 = Network Status.
  const a1 = cipGet(GW, path, DLR_CLASS, 1, 1)
  if (!a1.transportOk || a1.cipStatus !== 0 || a1.value.length < 1) {
    console.log(`    DLR      : none here (status 0x${(a1.cipStatus >>> 0).toString(16)}${a1.err ? ', ' + a1.err : ''})`)
    continue
  }
  const a2 = cipGet(GW, path, DLR_CLASS, 1, 2)
  const a5 = cipGet(GW, path, DLR_CLASS, 1, 5)
  const a8 = cipGet(GW, path, DLR_CLASS, 1, 8)
  const a6 = cipGet(GW, path, DLR_CLASS, 1, 6)
  const a7 = cipGet(GW, path, DLR_CLASS, 1, 7)

  const topology = a1.value[0]
  const netStatus = a2.cipStatus === 0 ? a2.value[0] : null
  console.log(`    DLR      : *** FOUND ***`)
  console.log(`      topology       = ${topology} (${topology === 1 ? 'Ring' : 'Linear'})`)
  console.log(`      networkStatus  = ${netStatus} (${netStatus != null ? NETWORK_STATUS[netStatus] ?? '?' : 'unread'})`)
  console.log(`      faultCount     = ${a5.cipStatus === 0 ? u16(a5.value) : 'unread'}`)
  console.log(`      participants   = ${a8.cipStatus === 0 ? u16(a8.value) : 'unread'}`)
  console.log(`      lastActiveNode1= ${a6.cipStatus === 0 ? ipOf(a6.value) : 'unread'}`)
  console.log(`      lastActiveNode2= ${a7.cipStatus === 0 ? ipOf(a7.value) : 'unread'}`)

  const verdict = topology !== 1 ? 'UNKNOWN (linear — not a DLR ring)'
                : netStatus === 0 ? 'HEALTHY (ring closed, Normal)'
                : `DEGRADED (${NETWORK_STATUS[netStatus] ?? netStatus})`
  console.log(`      => ringVerdict : ${verdict}`)
}
console.log('')
