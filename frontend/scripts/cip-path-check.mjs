// Read-only: does the backplane slot in `path=` actually reach different modules?
// Reads Identity (0x01) serial number + product code + name at each path. Two
// different slots MUST return different serial numbers if routing is honoured.
// If they are identical, the path is being ignored and any per-slot read (e.g.
// the DLR supervisor lookup) is silently hitting the wrong device.
//
//   node scripts/cip-path-check.mjs [gateway]
import { open, load, DataType } from 'ffi-rs'

const DLL = new URL('../plctag.dll', import.meta.url).pathname.replace(/^\//, '')
const GW = process.argv[2] || '192.168.20.40'
const PATHS = (process.argv[3] || '1,0|1,1|1,2|1,4|1,5|2,0').split('|')
const TIMEOUT = 2000

open({ library: 'plctag', path: DLL })
const L = (f, r, pt, pv) => load({ library: 'plctag', funcName: f, retType: r, paramsType: pt, paramsValue: pv })
const tagCreate = (a, t) => L('plc_tag_create', DataType.I32, [DataType.String, DataType.I32], [a, t])
const tagWrite  = (h, t) => L('plc_tag_write',  DataType.I32, [DataType.I32, DataType.I32], [h, t])
const setSize   = (h, n) => L('plc_tag_set_size', DataType.I32, [DataType.I32, DataType.I32], [h, n])
const getSize   = (h)    => L('plc_tag_get_size', DataType.I32, [DataType.I32], [h])
const setU8     = (h,o,v)=> L('plc_tag_set_uint8', DataType.I32, [DataType.I32, DataType.I32, DataType.I32], [h,o,v])
const getU8     = (h, o) => L('plc_tag_get_uint8', DataType.I32, [DataType.I32, DataType.I32], [h, o])
const destroy   = (h)    => L('plc_tag_destroy', DataType.I32, [DataType.I32], [h])

function cipGet(path, cls, inst, attr) {
  const h = tagCreate(`protocol=ab_eip&gateway=${GW}&path=${path}&cpu=logix&name=@raw`, TIMEOUT)
  if (h < 0) return { ok: false, err: `create=${h}` }
  try {
    const req = [0x0e, 0x03, 0x20, cls, 0x24, inst, 0x30, attr]
    setSize(h, req.length); req.forEach((b, i) => setU8(h, i, b))
    const st = tagWrite(h, TIMEOUT)
    if (st !== 0) return { ok: false, err: `write=${st}` }
    const n = getSize(h); const raw = []
    for (let i = 0; i < n; i++) raw.push(getU8(h, i) & 0xff)
    if (raw.length < 4) return { ok: false, err: 'short' }
    return { ok: true, status: raw[2], value: raw.slice(4 + 2 * raw[3]) }
  } finally { try { destroy(h) } catch {} }
}

const u32 = (v) => (v.length >= 4 ? ((v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0) : null)
const u16 = (v) => (v.length >= 2 ? (v[0] | (v[1] << 8)) : null)
const sstr = (v) => (v.length >= 1 ? String.fromCharCode(...v.slice(1, 1 + v[0])) : '')

console.log(`\n=== Does path= reach different slots?  gateway ${GW} (read-only) ===\n`)
console.log('  PATH    SERIAL       PRODCODE  REV    PRODUCT NAME')
console.log('  ' + '-'.repeat(74))

const seen = new Map()
for (const p of PATHS) {
  const ser = cipGet(p, 0x01, 1, 6)
  if (!ser.ok) { console.log(`  ${p.padEnd(7)} unreachable (${ser.err})`); continue }
  if (ser.status !== 0) { console.log(`  ${p.padEnd(7)} CIP 0x${ser.status.toString(16)}`); continue }
  const pc  = cipGet(p, 0x01, 1, 3)
  const rev = cipGet(p, 0x01, 1, 4)
  const nm  = cipGet(p, 0x01, 1, 7)
  const serial = u32(ser.value)
  const hex = serial != null ? '0x' + serial.toString(16).padStart(8, '0') : '?'
  const prod = pc.ok && pc.status === 0 ? u16(pc.value) : '?'
  const rv = rev.ok && rev.status === 0 && rev.value.length >= 2 ? `${rev.value[0]}.${rev.value[1]}` : '?'
  const name = nm.ok && nm.status === 0 ? sstr(nm.value) : '?'
  console.log(`  ${p.padEnd(7)} ${hex.padEnd(12)} ${String(prod).padEnd(9)} ${rv.padEnd(6)} ${name}`)
  seen.set(p, hex)
}

const uniq = new Set([...seen.values()])
console.log('\n  ' + '-'.repeat(74))
if (seen.size > 1 && uniq.size === 1) {
  console.log(`  VERDICT: all ${seen.size} paths returned the SAME serial (${[...uniq][0]}).`)
  console.log('           The backplane slot is NOT being honoured — every path lands on')
  console.log('           the same physical device. Per-slot reads are therefore unreliable.')
} else if (uniq.size > 1) {
  console.log(`  VERDICT: ${uniq.size} distinct serials across ${seen.size} paths — routing IS honoured.`)
} else {
  console.log('  VERDICT: not enough reachable paths to judge.')
}
console.log('')
