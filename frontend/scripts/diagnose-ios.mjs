import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const db = new Database(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'database.db'))

const SUB = 71

// 1) Schema of Ios
const cols = db.prepare(`PRAGMA table_info(Ios)`).all()
console.log('Ios columns:', cols.map(c => c.name).join(', '))

// 2) Any IO whose Name contains TPE/PE
const tpeByName = db.prepare(`
  SELECT id, Name, NetworkDeviceName, Description, Result
    FROM Ios WHERE SubsystemId = ? AND Name LIKE '%TPE%' LIMIT 6
`).all(SUB)
console.log('\nSample IOs with "TPE" in Name:')
for (const r of tpeByName) console.log(' ', r)

const peByName = db.prepare(`
  SELECT id, Name, NetworkDeviceName, Description
    FROM Ios WHERE SubsystemId = ? AND (Name LIKE '%_PE%' OR Name LIKE '%LPE%') LIMIT 6
`).all(SUB)
console.log('\nSample IOs with photoeye-ish Name:')
for (const r of peByName) console.log(' ', r)

// 3) Distinct NetworkDeviceName endings for this subsystem
const ndn = db.prepare(`
  SELECT DISTINCT NetworkDeviceName
    FROM Ios WHERE SubsystemId = ? AND NetworkDeviceName IS NOT NULL
`).all(SUB)
console.log('\nDistinct NetworkDeviceName count:', ndn.length)
const suffix = {}
for (const r of ndn) {
  const m = String(r.NetworkDeviceName).match(/_([A-Z]+)\d*$/)
  const k = m ? m[1] : '(other)'
  suffix[k] = (suffix[k] || 0) + 1
}
console.log('NetworkDeviceName suffix breakdown:', suffix)

// 4) Sample IO names overall for the subsystem (random)
const samples = db.prepare(`
  SELECT id, Name, NetworkDeviceName FROM Ios WHERE SubsystemId = ?
  ORDER BY RANDOM() LIMIT 12
`).all(SUB)
console.log('\nRandom IO samples:')
for (const r of samples) console.log(' ', r)

db.close()
