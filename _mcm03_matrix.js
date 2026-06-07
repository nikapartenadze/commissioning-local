const path = require('path')
const Module = require('module')
const nm = path.join(__dirname, 'frontend', 'node_modules')
Module.globalPaths.push(nm)
const Database = require(path.join(nm, 'better-sqlite3'))
const db = new Database(path.join(__dirname, 'mcm03', 'database.db'), { readonly: true })

const SHEET = 294
const colCheck = 969, colPol = 970

const rows = db.prepare(`
  SELECT d.id, d.DeviceName dev,
    (SELECT Value FROM L2CellValues WHERE DeviceId=d.id AND ColumnId=${colCheck}) AS checkDir,
    (SELECT Value FROM L2CellValues WHERE DeviceId=d.id AND ColumnId=${colPol})   AS polarity
  FROM L2Devices d WHERE d.SheetId=${SHEET} ORDER BY d.DeviceName
`).all()

let inv = 0, norm = 0, blank = 0, cdDone = 0
console.log('dev'.padEnd(15), 'CheckDir'.padEnd(12), 'Polarity')
for (const r of rows) {
  const p = r.polarity || ''
  if (/Inverter/i.test(p)) inv++
  else if (/Normal/i.test(p)) norm++
  else blank++
  if (r.checkDir && r.checkDir.trim()) cdDone++
  const flag = (r.checkDir && r.checkDir.trim() && !p) ? '  <-- CheckDir done, NO polarity' : ''
  console.log(r.dev.padEnd(15), String(r.checkDir||'∅').padEnd(12), (p||'∅') + flag)
}
console.log('\n=== Totals ===')
console.log('devices:', rows.length, '| CheckDir done:', cdDone)
console.log('Polarity = Inverter:', inv, '| Normal:', norm, '| blank:', blank)
console.log('\nDistinct polarity values:', [...new Set(rows.map(r=>r.polarity).filter(Boolean))])
db.close()
