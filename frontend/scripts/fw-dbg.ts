import { initLibrary, plc_tag_set_debug_level, plc_tag_create, plc_tag_status, plc_tag_destroy } from '@/lib/plc/libplctag'
const gw = process.argv[2], path = process.argv[3]
initLibrary()
plc_tag_set_debug_level(4 as any)
const attr = `protocol=ab_eip&gateway=${gw}&path=${path}&cpu=logix&name=@raw`
console.log('ATTR:', attr)
const t = plc_tag_create(attr, 0) // async create — don't block
console.log('create ->', t)
const started = Date.now()
const iv = setInterval(() => {
  const st = plc_tag_status(t)
  console.log(`t+${Date.now() - started}ms status=${st}`)
  if (st !== -1 /* PENDING */ || Date.now() - started > 12000) {
    clearInterval(iv); plc_tag_destroy(t); process.exit(0)
  }
}, 1000)
