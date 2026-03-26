import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'

const prisma = new PrismaClient()

async function main() {
  // Find CSV file
  let csvPath = path.join(process.cwd(), '..', 'CDW5_MCM11_ESTOP_Check_VFD_Matrix 3.csv')
  if (!fs.existsSync(csvPath)) {
    csvPath = path.join(process.cwd(), 'CDW5_MCM11_ESTOP_Check_VFD_Matrix 3.csv')
  }
  if (!fs.existsSync(csvPath)) {
    console.error('CSV file not found at', csvPath)
    process.exit(1)
  }

  console.log('Reading CSV from:', csvPath)
  const csvContent = fs.readFileSync(csvPath, 'utf-8')
  const lines = csvContent.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  // Skip header
  const dataLines = lines.slice(1)
  console.log(`Found ${dataLines.length} EPC rows in CSV`)

  // Clear existing data (order matters for foreign keys)
  console.log('Clearing existing EStop data...')
  await prisma.eStopVfd.deleteMany()
  await prisma.eStopIoPoint.deleteMany()
  await prisma.eStopEpc.deleteMany()
  await prisma.eStopZone.deleteMany()

  // Track zones by name
  const zoneMap = new Map<string, number>()

  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i]
    // Parse CSV - these fields don't contain commas inside quotes, so simple split works
    const parts = line.split(',')
    if (parts.length < 5) {
      console.warn(`Skipping line ${i + 2}: not enough columns`)
      continue
    }

    const checkTag = parts[0].trim()
    const zoneName = parts[1].trim()
    const ioPointsRaw = parts[2].trim()
    const mustStopRaw = parts[3].trim()
    const keepRunningRaw = parts[4].trim()

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
      data: {
        zoneId,
        name: epcName,
        checkTag,
      },
    })

    // Create IO points
    const ioTags = ioPointsRaw.split('; ').map(t => t.trim()).filter(t => t.length > 0)
    for (const tag of ioTags) {
      await prisma.eStopIoPoint.create({
        data: { epcId: epc.id, tag },
      })
    }

    // Create VFDs that must stop
    const mustStopTags = mustStopRaw.split('; ').map(t => t.trim()).filter(t => t.length > 0)
    for (const stoTag of mustStopTags) {
      // Extract VFD base name: everything before the first ':'
      const tag = stoTag.split(':')[0]
      await prisma.eStopVfd.create({
        data: { epcId: epc.id, tag, stoTag, mustStop: true },
      })
    }

    // Create VFDs that keep running
    const keepRunningTags = keepRunningRaw.split('; ').map(t => t.trim()).filter(t => t.length > 0)
    for (const stoTag of keepRunningTags) {
      const tag = stoTag.split(':')[0]
      await prisma.eStopVfd.create({
        data: { epcId: epc.id, tag, stoTag, mustStop: false },
      })
    }

    console.log(`  [${i + 1}/${dataLines.length}] ${epcName} - ${ioTags.length} IO points, ${mustStopTags.length} must-stop VFDs, ${keepRunningTags.length} keep-running VFDs`)
  }

  // Summary
  const zoneCount = await prisma.eStopZone.count()
  const epcCount = await prisma.eStopEpc.count()
  const ioCount = await prisma.eStopIoPoint.count()
  const vfdCount = await prisma.eStopVfd.count()

  console.log('\nSeed complete!')
  console.log(`  Zones: ${zoneCount}`)
  console.log(`  EPCs: ${epcCount}`)
  console.log(`  IO Points: ${ioCount}`)
  console.log(`  VFDs: ${vfdCount}`)
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
