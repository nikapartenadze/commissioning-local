// READ-ONLY extraction + sanity report. No DB writes.
const fs = require('fs')
const path = require('path')
const Module = require('module')
const nm = path.join(__dirname, 'frontend', 'node_modules')
Module.globalPaths.push(nm)
const Database = require(path.join(nm, 'better-sqlite3'))

const xml = fs.readFileSync(path.join(__dirname, 'CDW5_MCM03_REV1.L5X'), 'latin1')

// Scope a regex to the CMD StructureMember inside each VFD tag so we read the
// command polarity bits specifically (Reverse_Polarity also appears elsewhere).
const tagRe = /<Tag\b[^>]*\bName="(CBT_[A-Za-z0-9_]*_VFD)"[\s\S]*?<\/Tag>/g
function val(block, name) {
  const re = new RegExp('Name="' + name + '"[^>]*Value="([^"]*)"')
  const mm = block.match(re)
  return mm ? mm[1] : null
}
function cmdBlock(block) {
  // CMD structure starts at StructureMember Name="CMD" and ends at next </StructureMember> closing it.
  const i = block.indexOf('Name="CMD"')
  if (i < 0) return ''
  return block.slice(i, i + 4000) // CMD member is small; enough to cover its members
}

const rows = []
let m
while ((m = tagRe.exec(xml)) !== null) {
  const dev = m[1].replace(/^CBT_/, '')
  const block = m[0]
  const cmd = cmdBlock(block)
  const np = val(cmd, 'Normal_Polarity')
  const rp = val(cmd, 'Reverse_Polarity')
  const validDir = val(block, 'Valid_Direction') // from STS
  let polarity = null
  if (np === '1' && rp === '0') polarity = 'Normal'
  else if (np === '0' && rp === '1') polarity = 'Inverter'
  else if (np === '1' && rp === '1') polarity = 'CONFLICT(1,1)'
  else polarity = 'UNSET(0,0)'
  rows.push({ dev, np, rp, polarity, validDir })
}

const db = new Database(path.join(__dirname, 'database.db'), { readonly: true })
// Existing "Check Direction" cells on APF, keyed by device name
const cd = db.prepare(`
  SELECT d.DeviceName dev, cv.Value val
  FROM L2Devices d
  JOIN L2Columns c ON c.SheetId=d.SheetId AND c.Name='Check Direction'
  LEFT JOIN L2CellValues cv ON cv.DeviceId=d.id AND cv.ColumnId=c.id
  WHERE d.SheetId=288
`).all()
const cdMap = new Map(cd.map(r => [r.dev, r.val]))
db.close()

// Distribution
const dist = {}
for (const r of rows) dist[r.polarity] = (dist[r.polarity] || 0) + 1
console.log('=== Polarity distribution across', rows.length, 'MCM03 VFDs ===')
console.log(dist)

console.log('\n=== Per-device (dev | NP | RP | polarity | Valid_Direction | existing CheckDir cell) ===')
for (const r of rows.sort((a, b) => a.dev.localeCompare(b.dev))) {
  const cdv = cdMap.has(r.dev) ? (cdMap.get(r.dev) || '∅') : '(no dev)'
  console.log(
    r.dev.padEnd(16),
    'NP=' + r.np, 'RP=' + r.rp,
    (r.polarity).padEnd(13),
    'ValidDir=' + (r.validDir ?? '?'),
    '| CheckDir=' + cdv,
  )
}

// Cross-check contradictions
const setPol = rows.filter(r => r.polarity === 'Normal' || r.polarity === 'Inverter')
const validatedNoPol = rows.filter(r => r.validDir === '1' && (r.polarity.startsWith('UNSET') || r.polarity.startsWith('CONFLICT')))
console.log('\n=== Summary ===')
console.log('Devices with a usable polarity (Normal/Inverter):', setPol.length)
console.log('Devices Valid_Direction=1 but polarity UNSET/CONFLICT:', validatedNoPol.length,
  validatedNoPol.length ? '→ ' + validatedNoPol.map(r => r.dev + '(' + r.polarity + ')').join(', ') : '')
const checkDirDone = cd.filter(r => r.val && r.val !== '').length
console.log('Existing non-empty "Check Direction" cells in DB:', checkDirDone)
