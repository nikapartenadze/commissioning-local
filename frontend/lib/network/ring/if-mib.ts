/**
 * IF-MIB + EtherLike-MIB parsing.
 *
 * Turns walked varbinds into per-port interface stats keyed by ifIndex
 * (== port number for these switches). Pure — no SNMP transport here.
 *
 * Each of these columns is indexed by a single trailing ifIndex segment.
 */

import type { Varbind, RingPortStat } from './types';
import { IF_MIB, ETHERLIKE } from './oids';

function num(value: string | number | Buffer | null): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Trailing OID segment as an integer ifIndex if `oid` is under `base`, else null. */
function ifIndexUnder(oid: string, base: string): number | null {
  if (!oid.startsWith(base + '.')) return null;
  const idx = Number(oid.slice(base.length + 1));
  return Number.isFinite(idx) ? idx : null;
}

interface RawPort {
  operStatus?: number;
  ifSpeed?: number;
  highSpeed?: number;
  inErrors?: number;
  outErrors?: number;
  align?: number;
  fcs?: number;
  duplex?: number;
}

// Column base → field setter on the per-ifIndex accumulator.
const COLUMNS: Array<[string, (r: RawPort, v: number) => void]> = [
  [IF_MIB.OPER_STATUS, (r, v) => (r.operStatus = v)],
  [IF_MIB.SPEED, (r, v) => (r.ifSpeed = v)],
  [IF_MIB.HIGH_SPEED, (r, v) => (r.highSpeed = v)],
  [IF_MIB.IN_ERRORS, (r, v) => (r.inErrors = v)],
  [IF_MIB.OUT_ERRORS, (r, v) => (r.outErrors = v)],
  [ETHERLIKE.ALIGNMENT_ERRORS, (r, v) => (r.align = v)],
  [ETHERLIKE.FCS_ERRORS, (r, v) => (r.fcs = v)],
  [ETHERLIKE.DUPLEX_STATUS, (r, v) => (r.duplex = v)],
];

/**
 * Parse interface stats from varbinds gathered across IF-MIB and EtherLike-MIB
 * columns. Only ifIndexes that reported an operStatus are returned (real
 * interfaces), sorted ascending.
 */
export function parsePortStats(varbinds: Varbind[]): RingPortStat[] {
  const byIndex = new Map<number, RawPort>();

  for (const vb of varbinds) {
    for (const [base, set] of COLUMNS) {
      const idx = ifIndexUnder(vb.oid, base);
      if (idx == null) continue;
      let r = byIndex.get(idx);
      if (!r) {
        r = {};
        byIndex.set(idx, r);
      }
      set(r, num(vb.value));
      break; // an OID belongs to at most one column
    }
  }

  const out: RingPortStat[] = [];
  for (const [idx, r] of byIndex) {
    if (r.operStatus === undefined) continue; // not a real interface row
    const speedMbps =
      r.highSpeed && r.highSpeed > 0 ? r.highSpeed : Math.round((r.ifSpeed ?? 0) / 1_000_000);
    const fullDuplex = r.duplex === 3 ? true : r.duplex === 2 ? false : null;
    out.push({
      port: idx,
      linkUp: r.operStatus === 1,
      speedMbps,
      fullDuplex,
      inErrors: r.inErrors ?? 0,
      outErrors: r.outErrors ?? 0,
      fcsErrors: r.fcs ?? 0,
      alignmentErrors: r.align ?? 0,
    });
  }
  return out.sort((a, b) => a.port - b.port);
}
