import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'

const dbPath = path.join(__dirname, '..', 'database.db')
const csvPath = process.argv[2]

const db = new Database(dbPath, { readonly: true })

// --- Snapshot what's in the DB ---
const zones = db.prepare('SELECT id, Name FROM EStopZones ORDER BY Name').all() as any[]
const epcs  = db.prepare('SELECT id, ZoneId, Name, CheckTag FROM EStopEpcs ORDER BY CheckTag').all() as any[]
const ios   = db.prepare('SELECT EpcId, Tag FROM EStopIoPoints').all() as any[]
const vfds  = db.prepare('SELECT EpcId, Tag, StoTag, MustStop FROM EStopVfds').all() as any[]
const rels  = db.prepare('SELECT EpcId, Tag, MustDrop FROM EStopRelatedEpcs').all() as any[]

console.log('=== DB STATE ===')
console.log('Zones :', zones.length)
console.log('EPCs  :', epcs.length)
console.log('IOs   :', ios.length)
console.log('VFDs  :', vfds.length)
console.log('Rel.  :', rels.length)

console.log('\nZones in DB:')
for (const z of zones) console.log(' ', z.Name)

// Check: any zone NOT starting with MCM02?
const nonMcm02 = zones.filter(z => !String(z.Name).startsWith('MCM02_'))
console.log(`\nNon-MCM02 zones: ${nonMcm02.length}`)
if (nonMcm02.length > 0) nonMcm02.forEach(z => console.log(' !', z.Name))

// --- If CSV passed, compare row-by-row ---
if (csvPath && fs.existsSync(csvPath)) {
  const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const headers = lines[0].split(',').map(h => h.trim())
  const idx: Record<string, number> = {}
  headers.forEach((h, i) => { idx[h] = i })

  const csvCheckTags = new Set<string>()
  const csvZones = new Set<string>()
  let csvIo = 0, csvStop = 0, csvKeep = 0, csvDrop = 0, csvStay = 0

  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',')
    const tag = (p[idx['EPC_Check_Tag']] ?? '').trim()
    const zone = (p[idx['Zone']] ?? '').trim()
    csvCheckTags.add(tag); csvZones.add(zone)
    csvIo   += (p[idx['EPC_IO_Points']]    ?? '').split(';').map((t: string) => t.trim()).filter((t: string) => t).length
    csvStop += (p[idx['VFDs_Must_Stop']]   ?? '').split(';').map((t: string) => t.trim()).filter((t: string) => t).length
    csvKeep += (p[idx['VFDs_Keep_Running'] ?? -1] ?? '').toString().split(';').map((t: string) => t.trim()).filter((t: string) => t).length
    csvDrop += (p[idx['ESTOPs_Must_Drop']    ?? -1] ?? '').toString().split(';').map((t: string) => t.trim()).filter((t: string) => t).length
    csvStay += (p[idx['ESTOPs_Must_Stay_OK'] ?? -1] ?? '').toString().split(';').map((t: string) => t.trim()).filter((t: string) => t).length
  }

  console.log('\n=== CSV TOTALS ===')
  console.log('Zones :', csvZones.size)
  console.log('EPCs  :', csvCheckTags.size)
  console.log('IOs   :', csvIo)
  console.log('Stop  :', csvStop)
  console.log('Keep  :', csvKeep)
  console.log('Drop  :', csvDrop)
  console.log('Stay  :', csvStay)

  // Cross-checks
  const dbTags = new Set(epcs.map(e => e.CheckTag))
  const missingInDb = [...csvCheckTags].filter(t => !dbTags.has(t))
  const extraInDb   = [...dbTags].filter(t => !csvCheckTags.has(t))

  console.log('\n=== DIFF ===')
  console.log('CheckTags in CSV but missing from DB :', missingInDb.length)
  missingInDb.forEach(t => console.log('  -', t))
  console.log('CheckTags in DB but not in CSV       :', extraInDb.length)
  extraInDb.forEach(t => console.log('  +', t))

  const dbMustStop = vfds.filter(v => v.MustStop === 1).length
  const dbKeep     = vfds.filter(v => v.MustStop === 0).length
  const dbDrop     = rels.filter(r => r.MustDrop === 1).length
  const dbStay     = rels.filter(r => r.MustDrop === 0).length

  console.log('\n=== ROW-COUNT MATCH ===')
  console.log(`IOs   csv=${csvIo}   db=${ios.length}      ${csvIo === ios.length ? 'OK' : 'MISMATCH'}`)
  console.log(`Stop  csv=${csvStop} db=${dbMustStop}      ${csvStop === dbMustStop ? 'OK' : 'MISMATCH'}`)
  console.log(`Keep  csv=${csvKeep} db=${dbKeep}          ${csvKeep === dbKeep ? 'OK' : 'MISMATCH'}`)
  console.log(`Drop  csv=${csvDrop} db=${dbDrop}          ${csvDrop === dbDrop ? 'OK' : 'MISMATCH'}`)
  console.log(`Stay  csv=${csvStay} db=${dbStay}          ${csvStay === dbStay ? 'OK' : 'MISMATCH'}`)
}

db.close()
