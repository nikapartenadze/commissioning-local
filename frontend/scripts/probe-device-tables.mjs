import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const db = new Database(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'database.db'))

console.log('── All tables in local DB:')
const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
`).all()
for (const t of tables) console.log(' ', t.name)

console.log('\n── Tables that look device-related:')
const deviceish = tables.filter(t => /device|install|vfd|enclosure|sorter/i.test(t.name))
for (const t of deviceish) {
  console.log(`\n  Table: ${t.name}`)
  try {
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all()
    console.log('    Columns:', cols.map(c => c.name).join(', '))
    const cnt = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get()
    console.log('    Row count:', cnt.c)
    if (cnt.c > 0 && cnt.c < 10) {
      const rows = db.prepare(`SELECT * FROM ${t.name} LIMIT 3`).all()
      for (const r of rows) console.log('     ', r)
    } else if (cnt.c >= 10) {
      const rows = db.prepare(`SELECT * FROM ${t.name} LIMIT 2`).all()
      for (const r of rows) console.log('     sample:', r)
    }
  } catch (e) { console.log('    [error]', e.message) }
}

console.log('\n── Look for a deviceId column on Ios:')
const ioCols = db.prepare(`PRAGMA table_info(Ios)`).all()
const deviceCol = ioCols.find(c => /device.?id/i.test(c.name))
console.log('  Found:', deviceCol ? deviceCol.name : '(none)')

db.close()
