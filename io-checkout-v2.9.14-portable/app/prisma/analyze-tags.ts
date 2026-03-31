import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

async function main() {
  const ios = await p.io.findMany({ select: { name: true }, orderBy: { name: 'asc' } })
  console.log('Total IOs:', ios.length)

  // Tags that end with .N (bit notation)
  const bitTags = ios.filter(io => io.name && /\.\d+$/.test(io.name))
  console.log('\n=== Bit-style tags (Name.N) ===', bitTags.length)
  for (const t of bitTags.slice(0, 10)) console.log('  ', t.name)
  if (bitTags.length > 10) console.log('  ... and', bitTags.length - 10, 'more')

  // Tags without bit notation
  const nonBitTags = ios.filter(io => {
    if (!io.name) return false
    return !/\.\d+$/.test(io.name)
  })
  console.log('\n=== Non-bit tags ===', nonBitTags.length)
  for (const t of nonBitTags.slice(0, 20)) console.log('  ', t.name)

  // Group by suffix pattern (part after device name)
  const suffixes: Record<string, number> = {}
  for (const io of nonBitTags) {
    const name = io.name || ''
    const parts = name.split(':')
    const suffix = parts.slice(1).join(':')
    suffixes[suffix] = (suffixes[suffix] || 0) + 1
  }
  console.log('\nSuffix frequency:')
  const sorted = Object.entries(suffixes).sort((a, b) => b[1] - a[1])
  for (const [s, c] of sorted.slice(0, 20)) {
    console.log(`  ${s} (x${c})`)
  }

  // For bit-style tags, group by parent DINT
  if (bitTags.length > 0) {
    const parents: Record<string, string[]> = {}
    for (const io of bitTags) {
      const name = io.name || ''
      const lastDot = name.lastIndexOf('.')
      const parent = name.substring(0, lastDot)
      const bit = name.substring(lastDot + 1)
      if (!parents[parent]) parents[parent] = []
      parents[parent].push(bit)
    }
    console.log('\n=== Groupable DINT parents ===')
    console.log('Unique parents:', Object.keys(parents).length)
    console.log('If grouped: would need', Object.keys(parents).length, 'reads instead of', bitTags.length)
    for (const [parent, bits] of Object.entries(parents).slice(0, 10)) {
      console.log(`  ${parent} → bits [${bits.join(', ')}]`)
    }
  }
}

main()
  .catch(console.error)
  .finally(() => p.$disconnect())
