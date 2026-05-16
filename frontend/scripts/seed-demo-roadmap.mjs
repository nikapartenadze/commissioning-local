// One-shot seed: inserts a sample roadmap into the local Roadmaps SQLite
// table so the new "Roadmap" flow mode has something to play back without
// requiring the cloud to be deployed with the matching endpoints.
//
// Run from frontend/ with: node scripts/seed-demo-roadmap.mjs
//
// Safe to re-run — uses INSERT OR REPLACE.

import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(__dirname, '..', 'database.db')
const db = new Database(dbPath)

const steps = [
  {
    order: 1,
    kind: 'device',
    deviceName: 'UL17_20_VFD',
    instructionText: 'Go to UL17_20_VFD. Verify the drive shows ready, no faults.',
    transitText: 'Start at the south-east corner of MCM09.',
  },
  {
    order: 2,
    kind: 'device',
    deviceName: 'UL17_21_VFD',
    instructionText: 'Two steps to your left — UL17_21_VFD. Same checks.',
    transitText: 'Walk left along the row.',
  },
  {
    order: 3,
    kind: 'io',
    deviceName: 'UL17_22_VFD',
    ioName: 'UL17_22_VFD',
    instructionText: 'On UL17_22_VFD, manually trigger a fault and confirm the cabinet alarm fires.',
    transitText: 'Same row, one more left.',
  },
  {
    order: 4,
    kind: 'device',
    deviceName: 'UL20_19_VFD',
    instructionText: 'Move to UL20_19_VFD on the next row. Final check.',
    transitText: 'Walk across to row UL20.',
  },
]

const path_ = {
  segments: [
    { fromStep: 1, toStep: 2, points: [{ x: 200, y: 200 }, { x: 320, y: 200 }], style: 'arrow' },
    { fromStep: 2, toStep: 3, points: [{ x: 320, y: 200 }, { x: 440, y: 200 }], style: 'arrow' },
    { fromStep: 3, toStep: 4, points: [{ x: 440, y: 200 }, { x: 440, y: 360 }], style: 'arrow' },
  ],
}

const stmt = db.prepare(`
  INSERT OR REPLACE INTO Roadmaps
    (Id, ProjectId, Mcm, Name, Description, StepsJson, PathJson, IsPublished, UpdatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

stmt.run(
  999,
  1,
  'MCM09',
  'Demo VFD walkdown',
  'Locally seeded for testing — no cloud dependency.',
  JSON.stringify(steps),
  JSON.stringify(path_),
  1,
  new Date().toISOString(),
)

const row = db.prepare('SELECT Id, Name, Mcm, IsPublished FROM Roadmaps WHERE Id = 999').get()
console.log('Seeded:', row)
db.close()
