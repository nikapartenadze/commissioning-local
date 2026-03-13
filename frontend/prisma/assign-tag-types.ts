/**
 * Assign tagType to IOs based on description patterns.
 * Run: npx tsx prisma/assign-tag-types.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function classifyDescription(desc: string | null): string | null {
  if (!desc) return null;
  const dl = desc.toLowerCase();

  // Order matters — more specific patterns first
  if (dl.includes('beacon')) return 'BCN 24V Segment 1';
  if (dl.includes('pushbutton light') || dl.includes('pb_lt') || dl.includes('pblt') || (dl.includes('button') && dl.includes('light')))
    return 'Button Light';
  if (dl.includes('pushbutton') || dl.includes('push button'))
    return 'Button Press';
  if (dl.includes('photoeye') || dl.includes('tpe'))
    return 'TPE Dark Operated';
  if (dl.includes('vfd') || dl.includes('motor'))
    return 'Motor/VFD';
  if (dl.includes('disconnect'))
    return 'Disconnect Switch';
  if (dl.includes('light') || dl.includes('lamp') || dl.includes('indicator'))
    return 'Indicator Light';
  if (dl.includes('sensor') || dl.includes('prox'))
    return 'Sensor';
  if (dl.includes('valve') || dl.includes('solenoid'))
    return 'Valve/Solenoid';
  if (dl.includes('safety') || dl.includes('e-stop') || dl.includes('estop'))
    return 'Safety Device';

  return null; // Can't classify
}

async function main() {
  const ios = await prisma.io.findMany({ select: { id: true, description: true, tagType: true } });

  const counts: Record<string, number> = {};
  const updates: { id: number; tagType: string }[] = [];

  for (const io of ios) {
    const tagType = classifyDescription(io.description);
    if (tagType) {
      counts[tagType] = (counts[tagType] || 0) + 1;
      updates.push({ id: io.id, tagType });
    } else {
      counts['(unclassified)'] = (counts['(unclassified)'] || 0) + 1;
    }
  }

  console.log('\nTag type classification:');
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${v.toString().padStart(5)}  ${k}`));

  console.log(`\nTotal: ${ios.length} IOs, ${updates.length} will be assigned a tagType`);

  // Apply updates
  let updated = 0;
  for (const { id, tagType } of updates) {
    await prisma.io.update({ where: { id }, data: { tagType } });
    updated++;
  }

  console.log(`\nDone — updated ${updated} IOs.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
