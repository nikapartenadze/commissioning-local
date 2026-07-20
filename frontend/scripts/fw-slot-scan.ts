import { initLibrary } from '@/lib/plc/libplctag'
import { readIdentity } from '@/lib/plc/identity/identity-reader'

const gw = process.argv[2] || '192.168.20.40'
void (async () => {
  initLibrary()
  for (let slot = 0; slot <= 7; slot++) {
    const path = `1,${slot}`
    const id = await readIdentity(gw, path, 3000)
    console.log(
      `path ${path.padEnd(4)} ->`,
      id ? `vendor=${id.vendorId} pc=${id.productCode} rev=${id.revMajor}.${id.revMinor} serial=${id.serial} "${id.productName}"`
         : 'unreachable',
    )
  }
  process.exit(0)
})()
