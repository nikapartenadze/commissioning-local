// Diagnose where photoeye (TPE/BCN/PB/EPC) signals live in the local DB.
// Look for any IO whose Name or Description references NCP1_3_TPE3 etc.

import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.join(__dirname, '..', 'database.db'))
const SUB = 71

const queries = [
  { label: 'IOs with TPE3 anywhere in Name or Description', sql: `
      SELECT id, Name, NetworkDeviceName, Description
        FROM Ios
       WHERE SubsystemId = ?
         AND (Name LIKE '%TPE3%' OR Description LIKE '%TPE3%')
       LIMIT 10
  ` },
  { label: 'IOs with TPE anywhere', sql: `
      SELECT COUNT(*) as cnt
        FROM Ios
       WHERE SubsystemId = ?
         AND (Name LIKE '%TPE%' OR Description LIKE '%TPE%')
  ` },
  { label: 'Any IO whose Description starts with NCP1', sql: `
      SELECT id, Name, NetworkDeviceName, Description
        FROM Ios
       WHERE SubsystemId = ?
         AND Description LIKE 'NCP1%'
       LIMIT 8
  ` },
  { label: 'All IOs on NCP1_3 (the row TPE3 belongs to)', sql: `
      SELECT id, Name, NetworkDeviceName, Description
        FROM Ios
       WHERE SubsystemId = ?
         AND (NetworkDeviceName LIKE 'NCP1_3%' OR Name LIKE 'NCP1_3%' OR Description LIKE '%NCP1_3%')
       LIMIT 30
  ` },
  { label: 'Distinct NetworkDeviceName values for NCP1', sql: `
      SELECT DISTINCT NetworkDeviceName
        FROM Ios
       WHERE SubsystemId = ?
         AND NetworkDeviceName LIKE 'NCP1%'
  ` },
  { label: 'FIOM IOs (sample) — see pin naming + descriptions', sql: `
      SELECT id, Name, NetworkDeviceName, Description
        FROM Ios
       WHERE SubsystemId = ?
         AND NetworkDeviceName = 'NCP1_3_FIOM1'
       LIMIT 20
  ` },
  { label: 'Are there IOs with Description containing "PHOTOEYE" but no NetworkDeviceName?', sql: `
      SELECT id, Name, NetworkDeviceName, Description
        FROM Ios
       WHERE SubsystemId = ?
         AND Description LIKE '%PHOTOEYE%'
       LIMIT 12
  ` },
]

for (const q of queries) {
  console.log('\n──', q.label)
  const rows = db.prepare(q.sql).all(SUB)
  if (rows.length === 0) { console.log('  (no rows)') ; continue }
  for (const r of rows) console.log(' ', r)
}

db.close()
