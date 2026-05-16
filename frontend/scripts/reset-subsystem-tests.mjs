// Wipe Ios.Result for a given SubsystemId so the demo can start from a
// clean slate. Run from frontend/:
//   node scripts/reset-subsystem-tests.mjs [subsystemId]
// Defaults to 71 if no argument given.

import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(__dirname, '..', 'database.db')
const subsystemId = parseInt(process.argv[2] ?? '71', 10)

const db = new Database(dbPath)

const before = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN Result = 'Passed' THEN 1 ELSE 0 END) AS passed,
    SUM(CASE WHEN Result = 'Failed' THEN 1 ELSE 0 END) AS failed
  FROM Ios WHERE SubsystemId = ?
`).get(subsystemId)
console.log(`Subsystem ${subsystemId} before:`, before)

const info = db.prepare(`
  UPDATE Ios
     SET Result = NULL,
         TestedBy = NULL,
         Timestamp = NULL,
         Comments = NULL
   WHERE SubsystemId = ?
`).run(subsystemId)
console.log(`Cleared ${info.changes} IO rows.`)

db.close()
