// READ-ONLY. Locate DirectionCmd_0/_1 and read them per VFD device.
const fs = require('fs')
const path = require('path')
const xml = fs.readFileSync(path.join(__dirname, 'CDW5_MCM03_REV1.L5X'), 'latin1')

// Where does DirectionCmd_0 live? Print context once.
const di = xml.indexOf('DirectionCmd_0')
console.log('=== context around first DirectionCmd_0 ===')
console.log(xml.slice(di - 600, di + 200))

// Per VFD tag, read DirectionCmd_0 / _1 (scoped to the tag block).
const tagRe = /<Tag\b[^>]*\bName="(CBT_[A-Za-z0-9_]*_VFD)"[\s\S]*?<\/Tag>/g
function val(block, name) {
  const re = new RegExp('Name="' + name + '"[^>]*Value="([^"]*)"')
  const mm = block.match(re); return mm ? mm[1] : null
}
let m; const rows = []
while ((m = tagRe.exec(xml)) !== null) {
  const dev = m[1].replace(/^CBT_/, '')
  rows.push({ dev, d0: val(m[0], 'DirectionCmd_0'), d1: val(m[0], 'DirectionCmd_1') })
}
const dist = {}
for (const r of rows) { const k = `d0=${r.d0},d1=${r.d1}`; dist[k] = (dist[k] || 0) + 1 }
console.log('\n=== DirectionCmd distribution across', rows.length, 'VFDs ===')
console.log(dist)
console.log('\n=== devices where d0/d1 differ (would indicate a real direction) ===')
const differ = rows.filter(r => r.d0 !== r.d1)
console.log('count:', differ.length)
console.log(differ.slice(0, 80).map(r => `${r.dev}:d0=${r.d0},d1=${r.d1}`).join('\n'))
