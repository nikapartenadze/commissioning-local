/**
 * Throwaway probe: does libplctag reach the plc-sim, and does the @raw CIP
 * Identity read work? Prints raw status codes (readIdentity() swallows them).
 *
 *   npx tsx scripts/fw-identity-probe.ts [gateway] [path]
 */
import {
  initLibrary, plc_tag_create, plc_tag_set_size, plc_tag_set_uint8,
  writeTagAsync, plc_tag_get_size, plc_tag_get_raw_bytes, plc_tag_destroy,
  readTagAsync, plc_tag_get_int32,
} from '@/lib/plc/libplctag'
import { buildIdentityRequest, parseIdentityReply } from '@/lib/plc/identity/identity-parse'

const GW = process.argv[2] || '127.0.0.1'
const PATH = process.argv[3] || '1,0'
const T = 15_000

async function plainTag() {
  const attr = `protocol=ab_eip&gateway=${GW}&path=${PATH}&cpu=logix&elem_count=1&name=DUMMY_DINT`
  const t = plc_tag_create(attr, T)
  console.log('[plain] create ->', t)
  if (t < 0) return
  const s = await readTagAsync(t, T)
  console.log('[plain] read status', s, s === 0 ? `value=${plc_tag_get_int32(t, 0)}` : '')
  plc_tag_destroy(t)
}

async function identity() {
  const attr = `protocol=ab_eip&gateway=${GW}&path=${PATH}&cpu=logix&name=@raw`
  const t = plc_tag_create(attr, T)
  console.log('[ident] create ->', t)
  if (t < 0) return
  const req = buildIdentityRequest()
  console.log('[ident] request:', Buffer.from(req).toString('hex'))
  plc_tag_set_size(t, req.length)
  for (let i = 0; i < req.length; i++) plc_tag_set_uint8(t, i, req[i])
  const st = await writeTagAsync(t, T)
  console.log('[ident] write status', st)
  const size = plc_tag_get_size(t)
  console.log('[ident] reply size', size)
  if (size > 0) {
    const raw = Buffer.alloc(size)
    plc_tag_get_raw_bytes(t, 0, raw)
    console.log('[ident] reply:', raw.toString('hex'))
    console.log('[ident] parsed:', JSON.stringify(parseIdentityReply(raw)))
  }
  plc_tag_destroy(t)
}

void (async () => {
  initLibrary()
  console.log(`probing ${GW} path=${PATH} timeout=${T}ms`)
  await plainTag()
  await identity()
  process.exit(0)
})()
