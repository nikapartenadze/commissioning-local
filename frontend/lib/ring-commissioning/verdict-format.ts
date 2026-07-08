/**
 * Pure formatting helpers for the Ring Commissioning UI — verdict kind → badge
 * colour, and a one-line headline. No React, unit-tested.
 */
import type { LinkVerdict, RingCommissioningVerdict } from '@/lib/plc/network/ring-commissioning/compare'

export function verdictBadge(kind: LinkVerdict['kind']): { label: string; color: 'green' | 'red' | 'amber' | 'gray' } {
  switch (kind) {
    case 'match': return { label: 'Match', color: 'green' }
    case 'wrong-port': return { label: 'Wrong port', color: 'red' }
    case 'wrong-neighbor': return { label: 'Wrong neighbor', color: 'red' }
    case 'missing': return { label: 'Missing', color: 'red' }
    case 'unexpected': return { label: 'Unexpected', color: 'amber' }
    case 'termination-fault': return { label: 'Termination fault', color: 'red' }
    default: return { label: kind, color: 'gray' }
  }
}

export function verdictHeadline(v: RingCommissioningVerdict): string {
  if (v.healthy) return 'Ring healthy — wiring matches the approved baseline'
  if (!v.ringClosed) return `Ring open — ${v.ringReason}`
  const bad = [...v.links, ...v.leafVerdicts].filter(l => l.kind !== 'match').length + v.terminationFaults.length
  return `${bad} issue${bad === 1 ? '' : 's'} vs the drawing-confirmed baseline`
}
