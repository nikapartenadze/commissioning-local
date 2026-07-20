// Read-only follow-up probe: is the DLR object genuinely absent, or were we
// asking the wrong target? Checks the Ethernet Link (0xF6) and TCP/IP (0xF5)
// objects — if those answer at the same path, CIP object routing is fine and a
// missing 0x47 means DLR really is not present/enabled.
// NO WRITES — Get_Attribute_Single (0x0E) and Get_Attributes_All (0x01) only.
//
//   node scripts/dlr-live-probe2.mjs [gateway] [path]
import { open, load, DataType } from 'ffi-rs'

const DLL = new URL('../plctag.dll', import.meta.url).pathname.replace(/^\//, '')
const GW = process.argv[2] || '192.168.20.40'
const PATH = process.argv[3] || '1,0'
const TIMEOUT = 2000

open({ library: 'plctag', path: DLL })
const L = (funcName, retType, paramsType, paramsValue) =>
  load({ library: 'plctag', funcName, retType, paramsType, paramsValue })

const tagCreate = (a, t) => L('plc_tag_create', DataType.I32, [DataType.String, DataType.I32], [a, t])
const tagWrite  = (h, t) => L('plc_tag_write',  DataType.I32, [DataType.I32, DataType.I32], [h, t])
const setSize   = (h, n) => L('plc_tag_set_size', DataType.I32, [DataType.I32, DataType.I32], [h, n])
const getSize   = (h)    => L('plc_tag_get_size', DataType.I32, [DataType.I32], [h])
const setU8     = (h, o, v) => L('plc_tag_set_uint8', DataType.I32, [DataType.I32, DataType.I32, DataType.I32], [h, o, v])
const getU8     = (h, o) => L('plc_tag_get_uint8', DataType.I32, [DataType.I32, DataType.I32], [h, o])
const destroy   = (h)    => L('plc_tag_destroy', DataType.I32, [DataType.I32], [h])

const CIP_ERR = {
  0x00: 'Success', 0x02: 'Resource unavailable', 0x05: 'Path destination unknown',
  0x08: 'Service not supported', 0x09: 'Invalid attribute value',
  0x0e: 'Attribute not settable', 0x13: 'Not enough data',
  0x14: 'Attribute not supported', 0x16: 'Object does not exist',
}

function cip(gw, path, service, cls, inst, attr) {
  const attrStr = `protocol=ab_eip&gateway=${gw}&path=${path}&cpu=logix&name=@raw`
  const h = tagCreate(attrStr, TIMEOUT)
  if (h < 0) return { ok: false, err: `create=${h}` }
  try {
    // Get_Attributes_All (0x01) omits the attribute segment; 0x0E includes it.
    const req = attr == null
      ? [service, 0x02, 0x20, cls, 0x24, inst]
      : [service, 0x03, 0x20, cls, 0x24, inst, 0x30, attr]
    setSize(h, req.length)
    req.forEach((b, i) => setU8(h, i, b))
    const st = tagWrite(h, TIMEOUT)
    if (st !== 0) return { ok: false, err: `write=${st}` }
    const size = getSize(h)
    const raw = []
    for (let i = 0; i < size; i++) raw.push(getU8(h, i) & 0xff)
    if (raw.length < 4) return { ok: false, err: 'short reply' }
    const status = raw[2]
    return { ok: true, status, value: raw.slice(4 + 2 * raw[3]) }
  } finally { try { destroy(h) } catch { /* best-effort */ } }
}

const u16 = (v) => (v.length >= 2 ? v[0] | (v[1] << 8) : null)
const u32 = (v) => (v.length >= 4 ? (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0 : null)
const st = (r) => (r.ok ? `0x${r.status.toString(16).padStart(2, '0')} ${CIP_ERR[r.status] ?? ''}` : r.err)

console.log(`\n=== CIP object survey — ${GW} path=${PATH} (read-only) ===\n`)

const probes = [
  ['Identity 0x01 attr1  (vendor)',        0x0e, 0x01, 1, 1],
  ['TCP/IP  0xF5 attr1  (status)',         0x0e, 0xf5, 1, 1],
  ['EthLink 0xF6 inst1 attr1 (speed)',     0x0e, 0xf6, 1, 1],
  ['EthLink 0xF6 inst1 attr2 (flags)',     0x0e, 0xf6, 1, 2],
  ['EthLink 0xF6 inst2 attr1 (speed p2)',  0x0e, 0xf6, 2, 1],
  ['EthLink 0xF6 inst3 attr1 (speed p3)',  0x0e, 0xf6, 3, 1],
  ['DLR     0x47 inst1 attr1 (topology)',  0x0e, 0x47, 1, 1],
  ['DLR     0x47 inst1 GetAll',            0x01, 0x47, 1, null],
  ['DLR     0x47 inst2 attr1',             0x0e, 0x47, 2, 1],
]

for (const [label, service, cls, inst, attr] of probes) {
  const r = cip(GW, PATH, service, cls, inst, attr)
  let extra = ''
  if (r.ok && r.status === 0) {
    const v = r.value
    extra = `  bytes=[${v.slice(0, 8).join(',')}${v.length > 8 ? '…' : ''}]`
    if (cls === 0xf6 && attr === 1) extra += `  => ${u32(v)} Mbps`
    if (cls === 0xf6 && attr === 2) {
      const f = u32(v) ?? 0
      extra += `  => link ${f & 1 ? 'UP' : 'DOWN'}, ${f & 2 ? 'full' : 'half'}-duplex`
    }
    if (cls === 0x01 && attr === 1) extra += `  => vendor ${u16(v)}`
  }
  console.log(`  ${label.padEnd(38)} ${st(r).padEnd(30)}${extra}`)
}
console.log('')
