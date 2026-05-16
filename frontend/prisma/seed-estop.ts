import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'

const prisma = new PrismaClient()

// Resolve the CSV by searching a small list of likely locations. Lets
// developers drop a fresh "Zone Matrix" export anywhere reasonable
// without editing the script. Newer Zone-Matrix file wins over the
// legacy VFD-Matrix file when both exist.
function resolveCsvPath(): string | null {
  const candidates = [
    path.join(process.cwd(), '..', 'CDW5_MCM02_ESTOP_Check_Zone_Matrix.csv'),
    path.join(process.cwd(), 'CDW5_MCM02_ESTOP_Check_Zone_Matrix.csv'),
    path.join(process.cwd(), '..', 'CDW5_MCM11_ESTOP_Check_VFD_Matrix 3.csv'),
    path.join(process.cwd(), 'CDW5_MCM11_ESTOP_Check_VFD_Matrix 3.csv'),
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return null
}

async function main() {
  const csvPath = resolveCsvPath()
  if (!csvPath) {
    console.error('No EStop CSV found near cwd. Expected one of:')
    console.error('  ../CDW5_MCM02_ESTOP_Check_Zone_Matrix.csv (preferred, 2026 Zone Matrix)')
    console.error('  ../CDW5_MCM11_ESTOP_Check_VFD_Matrix 3.csv (legacy 5-col)')
    process.exit(1)
  }

  console.log('Reading CSV from:', csvPath)
  const csvContent = fs.readFileSync(csvPath, 'utf-8')
  const lines = csvContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
  if (lines.length < 2) {
    console.error('CSV has no data rows')
    process.exit(1)
  }

  // Header-driven parsing so this seed works on both the 2026 7-col Zone
  // Matrix and the legacy 5-col VFD Matrix without code duplication.
  const headers = lines[0].split(',').map(h => h.trim())
  const colIdx: Record<string, number> = {}
  headers.forEach((h, i) => { colIdx[h] = i })
  for (const required of ['EPC_Check_Tag', 'Zone', 'EPC_IO_Points']) {
    if (!(required in colIdx)) {
      console.error(`Missing required column: ${required}`)
      process.exit(1)
    }
  }

  const dataLines = lines.slice(1)
  console.log(`Found ${dataLines.length} EPC rows in CSV`)

  // Clear existing data (order matters for foreign keys)
  console.log('Clearing existing EStop data...')
  // eStopRelatedEpc may not exist on schemas pre-dating the Zone Matrix
  // migration; tolerate that gracefully.
  try { await (prisma as any).eStopRelatedEpc.deleteMany() } catch { /* table absent */ }
  await prisma.eStopVfd.deleteMany()
  await prisma.eStopIoPoint.deleteMany()
  await prisma.eStopEpc.deleteMany()
  await prisma.eStopZone.deleteMany()

  // Track zones by name
  const zoneMap = new Map<string, number>()

  for (let i = 0; i < dataLines.length; i++) {
    const parts = dataLines[i].split(',')

    const checkTag = (parts[colIdx['EPC_Check_Tag']] ?? '').trim()
    const zoneName = (parts[colIdx['Zone']] ?? '').trim()
    if (!checkTag || !zoneName) {
      console.warn(`Skipping line ${i + 2}: missing checkTag or zone`)
      continue
    }
    const ioPointsRaw = (parts[colIdx['EPC_IO_Points']] ?? '').trim()
    const mustStopRaw = colIdx['VFDs_Must_Stop'] !== undefined ? (parts[colIdx['VFDs_Must_Stop']] ?? '').trim() : ''
    const keepRunningRaw = colIdx['VFDs_Keep_Running'] !== undefined ? (parts[colIdx['VFDs_Keep_Running']] ?? '').trim() : ''
    const mustDropRaw = colIdx['ESTOPs_Must_Drop'] !== undefined ? (parts[colIdx['ESTOPs_Must_Drop']] ?? '').trim() : ''
    const mustStayOkRaw = colIdx['ESTOPs_Must_Stay_OK'] !== undefined ? (parts[colIdx['ESTOPs_Must_Stay_OK']] ?? '').trim() : ''

    // Find or create zone
    if (!zoneMap.has(zoneName)) {
      const zone = await prisma.eStopZone.create({
        data: { name: zoneName },
      })
      zoneMap.set(zoneName, zone.id)
      console.log(`  Created zone: ${zoneName} (id=${zone.id})`)
    }
    const zoneId = zoneMap.get(zoneName)!

    // Derive EPC name from check tag (remove _CHECKED suffix)
    const epcName = checkTag.replace(/_CHECKED$/, '')

    // Create EPC
    const epc = await prisma.eStopEpc.create({
      data: { zoneId, name: epcName, checkTag },
    })

    // IO points (this EPC's own pull-cord inputs)
    const ioTags = ioPointsRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const tag of ioTags) {
      await prisma.eStopIoPoint.create({ data: { epcId: epc.id, tag } })
    }

    // VFDs that must stop (STO must go active)
    const mustStopTags = mustStopRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const stoTag of mustStopTags) {
      await prisma.eStopVfd.create({
        data: { epcId: epc.id, tag: stoTag.split(':')[0], stoTag, mustStop: true },
      })
    }

    // VFDs that keep running (STO must NOT go active) — legacy 5-col only
    const keepRunningTags = keepRunningRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const stoTag of keepRunningTags) {
      await prisma.eStopVfd.create({
        data: { epcId: epc.id, tag: stoTag.split(':')[0], stoTag, mustStop: false },
      })
    }

    // ESTOPs that must drop with this one (new 2026 column)
    const mustDropTags = mustDropRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const tag of mustDropTags) {
      await (prisma as any).eStopRelatedEpc.create({
        data: { epcId: epc.id, tag, mustDrop: true },
      })
    }

    // ESTOPs that must stay healthy during this test (new 2026 column)
    const mustStayOkTags = mustStayOkRaw.split(';').map(t => t.trim()).filter(t => t.length > 0)
    for (const tag of mustStayOkTags) {
      await (prisma as any).eStopRelatedEpc.create({
        data: { epcId: epc.id, tag, mustDrop: false },
      })
    }

    console.log(`  [${i + 1}/${dataLines.length}] ${epcName} - ${ioTags.length} IO, ${mustStopTags.length} must-stop, ${keepRunningTags.length} keep-run, ${mustDropTags.length} must-drop, ${mustStayOkTags.length} stay-ok`)
  }

  // Summary
  const zoneCount = await prisma.eStopZone.count()
  const epcCount = await prisma.eStopEpc.count()
  const ioCount = await prisma.eStopIoPoint.count()
  const vfdCount = await prisma.eStopVfd.count()
  let relatedCount = 0
  try { relatedCount = await (prisma as any).eStopRelatedEpc.count() } catch { /* table absent */ }

  console.log('\nSeed complete!')
  console.log(`  Zones: ${zoneCount}`)
  console.log(`  EPCs: ${epcCount}`)
  console.log(`  IO Points: ${ioCount}`)
  console.log(`  VFDs: ${vfdCount}`)
  console.log(`  Related EPCs: ${relatedCount}`)
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
