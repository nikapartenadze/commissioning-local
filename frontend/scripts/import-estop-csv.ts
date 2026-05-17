// One-shot importer to reseed EStop* tables from a Zone Matrix CSV using
// better-sqlite3 directly (the runtime DB layer). The Prisma-based seed
// (prisma/seed-estop.ts) cannot read this DB because runtime stores
// CreatedAt as TEXT/INTEGER, not Prisma DateTime.
//
// Usage: tsx scripts/import-estop-csv.ts <abs-path-to-csv> [abs-path-to-db]

import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'

const csvPath = process.argv[2]
const dbPath = process.argv[3] || path.join(__dirname, '..', 'database.db')

if (!csvPath || !fs.existsSync(csvPath)) {
  console.error('CSV not found:', csvPath)
  process.exit(1)
}
console.log('CSV:', csvPath)
console.log('DB :', dbPath)

const csv = fs.readFileSync(csvPath, 'utf-8')
const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
if (lines.length < 2) { console.error('CSV has no rows'); process.exit(1) }

const headers = lines[0].split(',').map(h => h.trim())
const idx: Record<string, number> = {}
headers.forEach((h, i) => { idx[h] = i })
for (const req of ['EPC_Check_Tag', 'Zone', 'EPC_IO_Points']) {
  if (!(req in idx)) { console.error('Missing column:', req); process.exit(1) }
}

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const insertZone   = db.prepare('INSERT INTO EStopZones (Name) VALUES (?)')
const insertEpc    = db.prepare('INSERT INTO EStopEpcs (ZoneId, Name, CheckTag) VALUES (?, ?, ?)')
const insertIo     = db.prepare('INSERT INTO EStopIoPoints (EpcId, Tag) VALUES (?, ?)')
const insertVfd    = db.prepare('INSERT INTO EStopVfds (EpcId, Tag, StoTag, MustStop) VALUES (?, ?, ?, ?)')
const insertRel    = db.prepare('INSERT INTO EStopRelatedEpcs (EpcId, Tag, MustDrop) VALUES (?, ?, ?)')

const dataLines = lines.slice(1)
console.log(`Found ${dataLines.length} EPC rows`)

const tx = db.transaction(() => {
  // Clear in FK-safe order
  db.exec('DELETE FROM EStopRelatedEpcs;')
  db.exec('DELETE FROM EStopVfds;')
  db.exec('DELETE FROM EStopIoPoints;')
  db.exec('DELETE FROM EStopEpcs;')
  db.exec('DELETE FROM EStopZones;')

  const zoneMap = new Map<string, number>()

  for (let i = 0; i < dataLines.length; i++) {
    const parts = dataLines[i].split(',')
    const checkTag = (parts[idx['EPC_Check_Tag']] ?? '').trim()
    const zoneName = (parts[idx['Zone']] ?? '').trim()
    if (!checkTag || !zoneName) { console.warn(`Skip row ${i + 2}`); continue }

    const ioPointsRaw   = (parts[idx['EPC_IO_Points']]    ?? '').trim()
    const mustStopRaw   = idx['VFDs_Must_Stop']      !== undefined ? (parts[idx['VFDs_Must_Stop']]      ?? '').trim() : ''
    const keepRunRaw    = idx['VFDs_Keep_Running']   !== undefined ? (parts[idx['VFDs_Keep_Running']]   ?? '').trim() : ''
    const mustDropRaw   = idx['ESTOPs_Must_Drop']    !== undefined ? (parts[idx['ESTOPs_Must_Drop']]    ?? '').trim() : ''
    const mustStayOkRaw = idx['ESTOPs_Must_Stay_OK'] !== undefined ? (parts[idx['ESTOPs_Must_Stay_OK']] ?? '').trim() : ''

    let zoneId = zoneMap.get(zoneName)
    if (zoneId == null) {
      const r = insertZone.run(zoneName)
      zoneId = Number(r.lastInsertRowid)
      zoneMap.set(zoneName, zoneId)
      console.log(`  zone: ${zoneName} (id=${zoneId})`)
    }

    const epcName = checkTag.replace(/_CHECKED$/, '')
    const er = insertEpc.run(zoneId, epcName, checkTag)
    const epcId = Number(er.lastInsertRowid)

    const ioTags = ioPointsRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const t of ioTags) insertIo.run(epcId, t)

    const mustStop = mustStopRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const t of mustStop) insertVfd.run(epcId, t.split(':')[0], t, 1)

    const keepRun = keepRunRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const t of keepRun) insertVfd.run(epcId, t.split(':')[0], t, 0)

    const mustDrop = mustDropRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const t of mustDrop) insertRel.run(epcId, t, 1)

    const stayOk = mustStayOkRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const t of stayOk) insertRel.run(epcId, t, 0)

    console.log(`  [${i + 1}/${dataLines.length}] ${epcName} io=${ioTags.length} stop=${mustStop.length} keep=${keepRun.length} drop=${mustDrop.length} stay=${stayOk.length}`)
  }
})

tx()

const zoneCount = (db.prepare('SELECT COUNT(*) AS n FROM EStopZones').get() as any).n
const epcCount  = (db.prepare('SELECT COUNT(*) AS n FROM EStopEpcs').get() as any).n
const ioCount   = (db.prepare('SELECT COUNT(*) AS n FROM EStopIoPoints').get() as any).n
const vfdCount  = (db.prepare('SELECT COUNT(*) AS n FROM EStopVfds').get() as any).n
const relCount  = (db.prepare('SELECT COUNT(*) AS n FROM EStopRelatedEpcs').get() as any).n

console.log('\nDone.')
console.log(`  Zones: ${zoneCount}`)
console.log(`  EPCs : ${epcCount}`)
console.log(`  IO   : ${ioCount}`)
console.log(`  VFDs : ${vfdCount}`)
console.log(`  Rel. : ${relCount}`)

db.close()
