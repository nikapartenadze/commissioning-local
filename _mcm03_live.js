// READ-ONLY. Inspect the LIVE mcm03 field DB (with its WAL) + full L5X CBT structure.
const fs = require('fs')
const path = require('path')
const Module = require('module')
const nm = path.join(__dirname, 'frontend', 'node_modules')
Module.globalPaths.push(nm)
const Database = require(path.join(nm, 'better-sqlite3'))

// Open live DB read-only (better-sqlite3 will read committed WAL frames).
const db = new Database(path.join(__dirname, 'mcm03', 'database.db'), { readonly: true })

console.log('=== Sheets ===')
console.log(db.prepare('SELECT id,Name,CloudId FROM L2Sheets ORDER BY id').all())

console.log('\n=== Any column mentioning polarity/direction/invert ===')
console.log(db.prepare("SELECT id,SheetId,Name FROM L2Columns WHERE LOWER(Name) LIKE '%polar%' OR LOWER(Name) LIKE '%direction%' OR LOWER(Name) LIKE '%invert%'").all())

console.log('\n=== All columns on the APF/VFD sheet ===')
const vfdSheet = db.prepare("SELECT id,Name FROM L2Sheets WHERE UPPER(Name) LIKE '%APF%' OR UPPER(Name) LIKE '%VFD%'").get()
console.log('VFD sheet:', vfdSheet)
if (vfdSheet) {
  console.log(db.prepare('SELECT id,CloudId,Name,DisplayOrder FROM L2Columns WHERE SheetId=? ORDER BY DisplayOrder').all(vfdSheet.id))
}

// If a Polarity column exists anywhere, dump its cells
const polCols = db.prepare("SELECT id,SheetId,Name FROM L2Columns WHERE LOWER(Name) LIKE '%polar%'").all()
if (polCols.length) {
  const ids = polCols.map(c => c.id)
  const ph = ids.map(() => '?').join(',')
  console.log('\n=== Polarity cells (live DB) ===')
  console.log(db.prepare(`SELECT cv.DeviceId, d.DeviceName, cv.Value, cv.UpdatedBy, cv.UpdatedAt FROM L2CellValues cv JOIN L2Devices d ON d.id=cv.DeviceId WHERE cv.ColumnId IN (${ph}) ORDER BY d.DeviceName`).all(...ids))
}

// Check Direction cells on VFD sheet (compare to root copy)
if (vfdSheet) {
  const cd = db.prepare(`
    SELECT d.DeviceName dev, cv.Value val, cv.UpdatedBy, cv.UpdatedAt
    FROM L2Devices d
    JOIN L2Columns c ON c.SheetId=d.SheetId AND c.Name='Check Direction'
    LEFT JOIN L2CellValues cv ON cv.DeviceId=d.id AND cv.ColumnId=c.id
    WHERE d.SheetId=?
    ORDER BY d.DeviceName`).all(vfdSheet.id)
  console.log('\n=== Check Direction cells:', cd.filter(r => r.val).length, 'of', cd.length, 'devices have a value ===')
}
db.close()

console.log('\n\n########## FULL L5X STRUCTURE OF ONE VFD (CBT_UL15_2_VFD) ##########')
const xml = fs.readFileSync(path.join(__dirname, 'mcm03', 'CDW5_MCM03_REV1.L5X'), 'latin1')
const re = /<Tag\b[^>]*\bName="CBT_UL15_2_VFD"[\s\S]*?<\/Tag>/
const block = (xml.match(re) || [''])[0]
// Print every DataValueMember name=value, plus enclosing StructureMember names
const lines = block.split('\n').filter(l => /StructureMember Name=|DataValueMember Name=/.test(l))
for (const l of lines) {
  const sm = l.match(/StructureMember Name="([^"]+)"/)
  const dv = l.match(/DataValueMember Name="([^"]+)"[^>]*Value="([^"]*)"/)
  if (sm) console.log('  [STRUCT] ' + sm[1])
  else if (dv) {
    // only show interesting/non-zero or direction/polarity ones to keep it readable
    const name = dv[1], val = dv[2]
    if (/polar|direct|invert|valid|forward|reverse|normal/i.test(name) || (val !== '0' && val !== '0.0'))
      console.log('      ' + name + ' = ' + val)
  }
}
