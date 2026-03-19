import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Real CSV data for CDW5 MCM09 Network
// Ring loop: SLOT2_EN4TR → NCP1_1_DPM1 → NCP1_2_DPM1 → NCP1_3_DPM1 → back

interface DeviceEntry {
  port: number
  name: string
  ip: string
}

const DPM_DATA: Array<{
  name: string
  ip: string
  loopOrder: number
  devices: DeviceEntry[]
}> = [
  {
    name: 'NCP1_1_DPM1',
    ip: '11.200.1.2',
    loopOrder: 3,
    devices: [
      { port: 5, name: 'NCP1_2_FIOM1', ip: '11.200.1.20' },
      { port: 6, name: 'UL23_22_FIOM1', ip: '11.200.1.21' },
      { port: 7, name: 'UL26_19_FIOM1', ip: '11.200.1.22' },
      { port: 8, name: 'UL26_22_FIOM1', ip: '11.200.1.23' },
      { port: 9, name: 'UL29_19_FIOM1', ip: '11.200.1.24' },
      { port: 10, name: 'NCP1_1_VFD', ip: '11.200.1.25' },
      { port: 11, name: 'UL26_19_VFD', ip: '11.200.1.26' },
      { port: 12, name: 'UL26_20_VFD', ip: '11.200.1.27' },
      { port: 13, name: 'UL26_21_VFD', ip: '11.200.1.28' },
      { port: 14, name: 'UL26_22_VFD', ip: '11.200.1.29' },
      { port: 15, name: 'UL26_23_VFD', ip: '11.200.1.30' },
      { port: 16, name: 'UL26_24_VFD', ip: '11.200.1.31' },
      { port: 17, name: 'UL26_25_VFD', ip: '11.200.1.32' },
      { port: 18, name: 'UL29_19_VFD', ip: '11.200.1.33' },
      { port: 19, name: 'UL29_20_VFD', ip: '11.200.1.34' },
      { port: 20, name: 'UL29_21_VFD', ip: '11.200.1.35' },
      { port: 21, name: 'UL29_22_VFD', ip: '11.200.1.36' },
      { port: 22, name: 'UL29_23_VFD', ip: '11.200.1.37' },
    ],
  },
  {
    name: 'NCP1_2_DPM1',
    ip: '11.200.1.3',
    loopOrder: 4,
    devices: [
      { port: 5, name: 'PDP04_FIOM1', ip: '11.200.1.44' },
      { port: 6, name: 'PDP04_PMM1', ip: '11.200.1.45' },
      { port: 7, name: 'UL20_19_FIOM1', ip: '11.200.1.46' },
      { port: 8, name: 'UL23_19_FIOM1', ip: '11.200.1.47' },
      { port: 9, name: 'NCP1_2_VFD', ip: '11.200.1.48' },
      { port: 10, name: 'UL20_19_VFD', ip: '11.200.1.49' },
      { port: 11, name: 'UL20_20_VFD', ip: '11.200.1.50' },
      { port: 12, name: 'UL20_21_VFD', ip: '11.200.1.51' },
      { port: 13, name: 'UL20_22_VFD', ip: '11.200.1.52' },
      { port: 14, name: 'UL20_23_VFD', ip: '11.200.1.53' },
      { port: 15, name: 'UL20_24_VFD', ip: '11.200.1.54' },
      { port: 16, name: 'UL20_25_VFD', ip: '11.200.1.55' },
      { port: 17, name: 'UL23_19_VFD', ip: '11.200.1.56' },
      { port: 18, name: 'UL23_20_VFD', ip: '11.200.1.57' },
      { port: 19, name: 'UL23_21_VFD', ip: '11.200.1.58' },
      { port: 20, name: 'UL23_22_VFD', ip: '11.200.1.59' },
      { port: 21, name: 'UL23_23_VFD', ip: '11.200.1.60' },
      { port: 22, name: 'UL23_24_VFD', ip: '11.200.1.61' },
      { port: 23, name: 'UL23_25_VFD', ip: '11.200.1.62' },
    ],
  },
  {
    name: 'NCP1_3_DPM1',
    ip: '11.200.1.4',
    loopOrder: 5,
    devices: [
      { port: 5, name: 'NCP1_3_FIOM1', ip: '11.200.1.68' },
      { port: 6, name: 'UL17_19_FIOM1', ip: '11.200.1.69' },
      { port: 7, name: 'UL17_22_FIOM1', ip: '11.200.1.70' },
      { port: 8, name: 'UL20_22_FIOM1', ip: '11.200.1.71' },
      { port: 9, name: 'NCP1_3_VFD', ip: '11.200.1.72' },
      { port: 10, name: 'NCP1_4A_VFD', ip: '11.200.1.73' },
      { port: 11, name: 'NCP1_4B_VFD', ip: '11.200.1.74' },
      { port: 12, name: 'UL17_19_VFD', ip: '11.200.1.75' },
      { port: 13, name: 'UL17_20_VFD', ip: '11.200.1.76' },
      { port: 14, name: 'UL17_21_VFD', ip: '11.200.1.77' },
      { port: 15, name: 'UL17_22_VFD', ip: '11.200.1.78' },
      { port: 16, name: 'UL17_23_VFD', ip: '11.200.1.79' },
      { port: 17, name: 'UL17_24_VFD', ip: '11.200.1.80' },
      { port: 18, name: 'UL17_25_VFD', ip: '11.200.1.81' },
    ],
  },
]

function getDeviceType(name: string): string {
  if (name.includes('VFD')) return 'VFD'
  if (name.includes('FIOM')) return 'FIOM'
  if (name.includes('PMM')) return 'PMM'
  return 'Unknown'
}

async function main() {
  console.log('Seeding network topology data (CDW5 MCM09)...')

  // Clear existing
  await prisma.networkPort.deleteMany({})
  await prisma.networkNode.deleteMany({})
  await prisma.networkRing.deleteMany({})

  // Create ring
  const ring = await prisma.networkRing.create({
    data: {
      subsystemId: 16,
      name: 'CDW5 MCM09 Network',
      mcmName: 'SLOT2_EN4TR',
      mcmIp: '11.200.1.1',
      mcmTag: '', // Controller doesn't have ConnectionFaulted
    },
  })

  console.log(`  Created ring: ${ring.name}`)

  for (const dpm of DPM_DATA) {
    const node = await prisma.networkNode.create({
      data: {
        ringId: ring.id,
        name: dpm.name,
        position: dpm.loopOrder,
        ipAddress: dpm.ip,
        statusTag: `${dpm.name}:I.ConnectionFaulted`,
        totalPorts: 28,
      },
    })

    for (const device of dpm.devices) {
      await prisma.networkPort.create({
        data: {
          nodeId: node.id,
          portNumber: device.port,
          deviceName: device.name,
          deviceIp: device.ip,
          deviceType: getDeviceType(device.name),
          statusTag: `${device.name}:I.ConnectionFaulted`,
        },
      })
    }

    console.log(`  Created ${dpm.name} with ${dpm.devices.length} devices`)
  }

  console.log('Network topology seeded successfully!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
