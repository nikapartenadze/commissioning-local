// READ-ONLY probe. Understand L5X polarity encoding + DB device correspondence.
const fs = require('fs')
const path = require('path')
const Module = require('module')
const nm = path.join(__dirname, 'frontend', 'node_modules')
Module.globalPaths.push(nm)
const Database = require(path.join(nm, 'better-sqlite3'))

const L5X = path.join(__dirname, 'CDW5_MCM03_REV1.L5X')
const xml = fs.readFileSync(L5X, 'latin1')

// 1) Find one CBT_*_VFD tag block and print the region around its CMD polarity members.
const tagRe = /<Tag\b[^>]*\bName="(CBT_[A-Za-z0-9_]*_VFD)"[\s\S]*?<\/Tag>/g
let m, count = 0, firstBlock = null, names = []
while ((m = tagRe.exec(xml)) !== null) {
  names.push(m[1])
  if (!firstBlock && /Normal_Polarity/.test(m[0])) firstBlock = m[0]
  count++
}
console.log('=== CBT_*_VFD <Tag> blocks found:', count)
console.log('First 10 tag names:', names.slice(0, 10).join(', '))

if (firstBlock) {
  const idx = firstBlock.indexOf('Normal_Polarity')
  console.log('\n=== Sample around Normal_Polarity in first VFD tag (tag '
    + (firstBlock.match(/Name="([^"]+)"/) || [])[1] + ') ===')
  console.log(firstBlock.slice(Math.max(0, idx - 400), idx + 400))
} else {
  console.log('No CBT_*_VFD tag block contained Normal_Polarity directly — maybe nested differently.')
}

// 2) DB device correspondence
const db = new Database(path.join(__dirname, 'database.db'), { readonly: true })
const dv = db.prepare('SELECT id,SheetId,DeviceName FROM L2Devices').all()
const apf = dv.filter(d => d.SheetId === 288).map(d => d.DeviceName)
console.log('\n=== DB: total L2Devices', dv.length, '| APF(288) devices', apf.length)
console.log('APF sample:', apf.slice(0, 12).join(', '))

const l5xDevices = names.map(n => n.replace(/^CBT_/, ''))
const setL5X = new Set(l5xDevices)
const setAPF = new Set(apf)
const inBoth = apf.filter(d => setL5X.has(d))
const onlyDB = apf.filter(d => !setL5X.has(d))
const onlyL5X = l5xDevices.filter(d => !setAPF.has(d))
console.log('\n=== Correspondence (APF device == CBT_<name> with prefix stripped)')
console.log('In BOTH:', inBoth.length, '| only in DB-APF:', onlyDB.length, '| only in L5X:', onlyL5X.length)
console.log('only in DB-APF sample:', onlyDB.slice(0, 10).join(', '))
console.log('only in L5X sample:', onlyL5X.slice(0, 10).join(', '))
db.close()
