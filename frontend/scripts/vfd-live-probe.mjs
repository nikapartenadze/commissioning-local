// Read-only connectivity probe for the CDW5 MCM02 staging controller.
// Uses the tool's own plctag.dll via ffi-rs. NO writes — reads STS + module bits.
//   node scripts/vfd-live-probe.mjs
import { open, close, load, DataType } from 'ffi-rs'

const DLL = new URL('../plctag.dll', import.meta.url).pathname.replace(/^\//, '')
const GW = process.env.PLC_GW || '192.168.5.108'
const PATH = process.env.PLC_PATH || '1,0'
const PLC = 'controllogix'

open({ library: 'plctag', path: DLL })
const L = (funcName, retType, paramsType, paramsValue) =>
  load({ library: 'plctag', funcName, retType, paramsType, paramsValue })

const tagCreate = (attr, t) => L('plc_tag_create', DataType.I32, [DataType.String, DataType.I32], [attr, t])
const tagRead   = (h, t)    => L('plc_tag_read',   DataType.I32, [DataType.I32, DataType.I32], [h, t])
const getBit    = (h, b)    => L('plc_tag_get_bit',    DataType.I32, [DataType.I32, DataType.I32], [h, b])
const getU32    = (h, o)    => L('plc_tag_get_uint32', DataType.U32, [DataType.I32, DataType.I32], [h, o])
const destroy   = (h)       => L('plc_tag_destroy', DataType.I32, [DataType.I32], [h])

const attr = (name, elem) =>
  `protocol=ab_eip&gateway=${GW}&path=${PATH}&plc=${PLC}&elem_size=${elem}&elem_count=1&name=${name}`

function readBit(name) {
  const h = tagCreate(attr(name, 1), 5000)
  if (h < 0) return { err: `create=${h}` }
  const s = tagRead(h, 5000)
  if (s !== 0) { destroy(h); return { err: `read=${s}` } }
  const bit = getBit(h, 0); destroy(h)
  return { bit }
}
function readReal(name) {
  const h = tagCreate(attr(name, 4), 5000)
  if (h < 0) return { err: `create=${h}` }
  const s = tagRead(h, 5000)
  if (s !== 0) { destroy(h); return { err: `read=${s}` } }
  const raw = getU32(h, 0) >>> 0; destroy(h)
  const b = Buffer.alloc(4); b.writeUInt32LE(raw, 0)
  return { real: Math.round(b.readFloatLE(0) * 100) / 100 }
}
const fmt = (r) => r.err ? `ERR(${r.err})` : (r.bit !== undefined ? String(r.bit) : String(r.real))

const devices = process.env.DEVS
  ? process.env.DEVS.split(',')
  : ['UL21_2_VFD','UL21_3_VFD','UL21_4_VFD','UL21_5_VFD','UL21_6_VFD','UL21_7_VFD']

console.log(`# probe ${GW} path=${PATH}  dll=${DLL}`)
console.log('device'.padEnd(14), 'Check_Allowed  Valid_Map  Valid_HP  RVS      ConnFaulted  STO')
for (const d of devices) {
  const ca  = readBit(`CBT_${d}.CTRL.STS.Check_Allowed`)
  const vm  = readBit(`CBT_${d}.CTRL.STS.Valid_Map`)
  const vhp = readBit(`CBT_${d}.CTRL.STS.Valid_HP`)
  const rvs = readReal(`CBT_${d}.CTRL.STS.RVS`)
  const cf  = readBit(`${d}:I.ConnectionFaulted`)
  const sto = readBit(`${d}:I.SafeTorqueEnabled`)
  console.log(
    d.padEnd(14),
    fmt(ca).padEnd(14), fmt(vm).padEnd(10), fmt(vhp).padEnd(9),
    fmt(rvs).padEnd(8), fmt(cf).padEnd(12), fmt(sto)
  )
}
close('plctag')
