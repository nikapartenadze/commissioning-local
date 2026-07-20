import { initLibrary, plc_tag_create, plc_tag_set_size, plc_tag_set_uint8, writeTagAsync, plc_tag_get_size, plc_tag_get_raw_bytes, plc_tag_destroy } from '@/lib/plc/libplctag'
import { buildIdentityRequest, parseIdentityReply } from '@/lib/plc/identity/identity-parse'
const gw = process.argv[2], path = process.argv[3]
void (async () => {
  initLibrary()
  const attr = `protocol=ab_eip&gateway=${gw}&path=${path}&cpu=logix&use_connected_msg=0&name=@raw`
  console.log('ATTR:', attr)
  const t = plc_tag_create(attr, 10000)
  console.log('create ->', t)
  if (t < 0) return process.exit(0)
  const req = buildIdentityRequest()
  plc_tag_set_size(t, req.length)
  for (let i = 0; i < req.length; i++) plc_tag_set_uint8(t, i, req[i])
  const st = await writeTagAsync(t, 10000)
  console.log('write status', st)
  const size = plc_tag_get_size(t)
  if (size > 0) {
    const raw = Buffer.alloc(size); plc_tag_get_raw_bytes(t, 0, raw)
    console.log('parsed:', JSON.stringify(parseIdentityReply(raw)))
  } else console.log('no reply')
  plc_tag_destroy(t); process.exit(0)
})()
