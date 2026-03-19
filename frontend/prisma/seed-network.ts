import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding network topology data...')

  // Clear existing
  await prisma.networkPort.deleteMany({})
  await prisma.networkNode.deleteMany({})
  await prisma.networkRing.deleteMany({})

  // Create ring: MCM09 DLR Loop
  const ring = await prisma.networkRing.create({
    data: {
      subsystemId: 16,
      name: 'MCM09 DLR Ring',
      mcmName: 'MCM09',
      mcmTag: 'MCM09:ConnectionFaulted',
    }
  })

  // DPM nodes in ring order
  const dpmData = [
    { name: 'NCP1_1_DPM1', position: 1, ip: '192.168.1.11', cableIn: 'R01S02_ETHCBLP1', cableOut: 'R01S02_ETHCBLP2', statusTag: 'NCP1_1_DPM1:ConnectionFaulted' },
    { name: 'NCP1_2_DPM1', position: 2, ip: '192.168.1.12', cableIn: 'R01S02_ETHCBLP2', cableOut: 'R01S02_ETHCBLP3', statusTag: 'NCP1_2_DPM1:ConnectionFaulted' },
    { name: 'NCP1_3_DPM1', position: 3, ip: '192.168.1.13', cableIn: 'R01S02_ETHCBLP3', cableOut: 'R01S02_ETHCBLP4', statusTag: 'NCP1_3_DPM1:ConnectionFaulted' },
    { name: 'NCP1_4_DPM1', position: 4, ip: '192.168.1.14', cableIn: 'R01S02_ETHCBLP4', cableOut: 'R01S02_ETHCBLP5', statusTag: 'NCP1_4_DPM1:ConnectionFaulted' },
    { name: 'NCP1_5_DPM1', position: 5, ip: '192.168.1.15', cableIn: 'R01S02_ETHCBLP5', cableOut: 'R01S02_ETHCBLP6', statusTag: 'NCP1_5_DPM1:ConnectionFaulted' },
  ]

  for (const dpm of dpmData) {
    const node = await prisma.networkNode.create({
      data: {
        ringId: ring.id,
        name: dpm.name,
        position: dpm.position,
        ipAddress: dpm.ip,
        cableIn: dpm.cableIn,
        cableOut: dpm.cableOut,
        statusTag: dpm.statusTag,
        totalPorts: 28,
      }
    })

    // Add ports with sample devices
    const portDevices: Array<{ port: number; cable: string; device: string; type: string; tag?: string }> = []

    // Generate realistic port assignments based on DPM name
    const prefix = dpm.name.replace('_DPM1', '')
    for (let p = 1; p <= 18; p++) {
      const cblNum = String((dpm.position - 1) * 18 + p).padStart(2, '0')
      let deviceName = ''
      let deviceType = ''
      let tag = ''

      if (p <= 3) {
        // First few ports: POINT I/O modules
        deviceName = `${prefix}_${p}S_POINT`
        deviceType = 'POINT_IO'
        tag = `${deviceName}:ConnectionFaulted`
      } else if (p <= 6) {
        // VFDs
        deviceName = `${prefix}_${p - 3}S_VFD`
        deviceType = 'VFD'
        tag = `${deviceName}:ConnectionFaulted`
      } else if (p <= 10) {
        // SIO modules
        deviceName = `${prefix}_SIO${p - 6}`
        deviceType = 'SIO'
        tag = `${deviceName}:ConnectionFaulted`
      } else if (p <= 14) {
        // FIO modules
        deviceName = `${prefix}_FIO${p - 10}`
        deviceType = 'FIO'
        tag = `${deviceName}:ConnectionFaulted`
      } else {
        // Spare/empty
        continue
      }

      portDevices.push({
        port: p,
        cable: `CBL${cblNum}`,
        device: deviceName,
        type: deviceType,
        tag,
      })
    }

    for (const pd of portDevices) {
      await prisma.networkPort.create({
        data: {
          nodeId: node.id,
          portNumber: pd.port,
          cableLabel: pd.cable,
          deviceName: pd.device,
          deviceType: pd.type,
          statusTag: pd.tag || null,
        }
      })
    }

    console.log(`  Created ${dpm.name} with ${portDevices.length} ports`)
  }

  console.log('Network topology seeded successfully!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
