import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

function isTpeFamily(tagType: string): boolean {
  return tagType === 'TPE' || tagType.startsWith('TPE ')
}

// Failure reasons that apply to every tag type. The cloud sidebar
// surfaces "3rd Party" and "Mech" as quick filters so coordinators
// can isolate non-electrical blockers across the project — they
// must therefore be selectable on any IO regardless of tagType.
// 'Other' (when present) is kept last to match historical ordering.
const UNIVERSAL_MODES = ['3rd Party', 'Mech'] as const

function mergeUniversalModes(dbModes: string[]): string[] {
  const otherIdx = dbModes.indexOf('Other')
  const head = otherIdx >= 0 ? dbModes.slice(0, otherIdx) : dbModes
  const tail = otherIdx >= 0 ? dbModes.slice(otherIdx) : []
  const additions = UNIVERSAL_MODES.filter(m => !dbModes.includes(m))
  return [...head, ...additions, ...tail]
}

function mergeFamilyModes(tagType: string, dbModes: string[]): string[] {
  if (!isTpeFamily(tagType)) return dbModes
  if (dbModes.includes('Needs alignment')) return dbModes
  // Insert before 'Other' so 'Other' stays last.
  const otherIdx = dbModes.indexOf('Other')
  if (otherIdx >= 0) return [...dbModes.slice(0, otherIdx), 'Needs alignment', ...dbModes.slice(otherIdx)]
  return [...dbModes, 'Needs alignment']
}

export async function GET(req: Request, res: Response) {
  try {
    const tagType = req.query.tagType as string | undefined

    if (tagType) {
      const rows = db
        .prepare('SELECT FailureMode FROM TagTypeDiagnostics WHERE TagType = ? ORDER BY FailureMode ASC')
        .all(tagType) as { FailureMode: string }[]
      const family = mergeFamilyModes(tagType, rows.map(d => d.FailureMode))
      const modes = mergeUniversalModes(family)
      return res.json(modes)
    }

    const rows = db
      .prepare('SELECT DISTINCT FailureMode FROM TagTypeDiagnostics ORDER BY FailureMode ASC')
      .all() as { FailureMode: string }[]
    return res.json(mergeUniversalModes(rows.map(d => d.FailureMode)))
  } catch (error) {
    console.error('Failed to fetch failure modes:', error)
    return res.status(500).json({ error: 'Failed to fetch failure modes' })
  }
}
