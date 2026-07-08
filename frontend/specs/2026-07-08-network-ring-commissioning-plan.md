# Network Comms Ring Commissioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify — from the field laptop, on demand — that the comms ring's switches are cabled to the right switches on the right ports (the MTN6 mis-wire), that leaf devices sit on their drawn ports, that the ring is closed, and that terminations are clean; comparing a live SNMP+CIP read against an operator-approved "golden baseline".

**Architecture:** New isolated modules under `lib/plc/network/ring-commissioning/`. A pure verdict engine (`compare.ts`) is the heart and is fully unit-tested. Live reads come from a lazy, optional `net-snmp` client wrapped so it can never throw, plus the existing DLR reader. On-demand only: nothing runs unless the operator presses Capture or Check. Baseline persists in local SQLite. No background timers, no changes to the testing grid / sync / PLC lifecycle.

**Tech Stack:** TypeScript, Express 5 route handlers, `better-sqlite3`, `net-snmp` (pure-JS, lazy-required), Vitest, React 18 + Vite (UII panel), existing `lib/plc/network/dlr.ts` + CIP `0xF6` diagnostics.

## Global Constraints

- **On-demand only** — no background/interval polling anywhere in this feature. Reads happen inside a route handler triggered by an operator button press.
- **Lazy, optional SNMP dependency** — `net-snmp` is `require`d lazily at first use inside a `try/catch`; on load or runtime failure the feature returns `{ available: false, reason }` and the rest of the tool is unaffected.
- **Additive only** — new tables via `CREATE TABLE IF NOT EXISTS`; new routes are new files mounted in `routes/index.ts`; the config field is a new optional property. No existing table, route, component, poller, or type is modified in a behaviour-changing way (the two exceptions are pure additions: one `AppConfig` optional field and one block of `CREATE TABLE IF NOT EXISTS` in the startup migration).
- **Fail-safe** — every SNMP call is timeout-bounded; every route handler returns HTTP 200 with `{ ok:false, reason }` on failure (never a 500 cascade). No throw may propagate into the main tool.
- **Local-only Phase 1** — baseline stored in local SQLite; no cloud sync in this plan.
- **Read-only** — the feature never writes to switches or the PLC.
- **File paths** are relative to `frontend/`. Column names are PascalCase (matches `NetworkRings`). Tests live in `frontend/__tests__/`.

---

### Task 1: Types + verdict comparison core

The pure heart of the feature. No I/O. Fully unit-tested — correct regardless of hardware.

**Files:**
- Create: `lib/plc/network/ring-commissioning/types.ts`
- Create: `lib/plc/network/ring-commissioning/compare.ts`
- Test: `__tests__/ring-commissioning-compare.test.ts`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces:
  - `types.ts` exports interfaces: `SwitchLink { localDevice: string; localPort: number; remoteDevice: string; remotePort: number }`, `LeafPlacement { device: string; switchName: string; port: number }`, `PortTermination { device: string; port: number; linkUp: boolean; speedMbps: number; fullDuplex: boolean; mediaErrors: boolean }`, `RingState { closed: boolean; source: 'dlr'|'moxa'|'mrp'|'none'; reason: string; breakBetween?: [string, string] }`, `RingTopology { links: SwitchLink[]; leaves: LeafPlacement[]; terminations: PortTermination[]; ring: RingState }`, `RingBaseline { subsystemId: number; ringName: string; capturedAt: string; approvedBy: string | null; approvedAt: string | null; topology: RingTopology }`.
  - `compare.ts` exports `type LinkVerdictKind = 'match'|'wrong-port'|'wrong-neighbor'|'missing'|'unexpected'|'termination-fault'`, `interface LinkVerdict { kind: LinkVerdictKind; expected?: SwitchLink | LeafPlacement; actual?: SwitchLink | LeafPlacement; detail: string }`, `interface RingCommissioningVerdict { healthy: boolean; ringClosed: boolean; ringReason: string; links: LinkVerdict[]; leafVerdicts: LinkVerdict[]; terminationFaults: LinkVerdict[] }`, and the function `compareTopology(baseline: RingTopology, actual: RingTopology): RingCommissioningVerdict`.

- [ ] **Step 1: Write the types file**

```typescript
// lib/plc/network/ring-commissioning/types.ts
/** One directed switch->switch cable as seen by LLDP: a local port on
 *  localDevice connects to remotePort on remoteDevice. */
export interface SwitchLink {
  localDevice: string
  localPort: number
  remoteDevice: string
  remotePort: number
}

/** A leaf (non-switch) device placed on a switch port, from the bridge FDB. */
export interface LeafPlacement {
  device: string
  switchName: string
  port: number
}

/** Per-port termination health, sourced from the existing CIP 0xF6 read. */
export interface PortTermination {
  device: string
  port: number
  linkUp: boolean
  speedMbps: number
  fullDuplex: boolean
  mediaErrors: boolean
}

/** Ring open/closed verdict + provenance (DLR, Moxa Turbo Ring, MRP, or none). */
export interface RingState {
  closed: boolean
  source: 'dlr' | 'moxa' | 'mrp' | 'none'
  reason: string
  breakBetween?: [string, string]
}

/** A full ring read (captured actual, or a stored baseline's topology). */
export interface RingTopology {
  links: SwitchLink[]
  leaves: LeafPlacement[]
  terminations: PortTermination[]
  ring: RingState
}

/** An operator-approved golden baseline for one ring. */
export interface RingBaseline {
  subsystemId: number
  ringName: string
  capturedAt: string
  approvedBy: string | null
  approvedAt: string | null
  topology: RingTopology
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// __tests__/ring-commissioning-compare.test.ts
import { describe, it, expect } from 'vitest'
import { compareTopology } from '@/lib/plc/network/ring-commissioning/compare'
import type { RingTopology } from '@/lib/plc/network/ring-commissioning/types'

function base(): RingTopology {
  return {
    links: [{ localDevice: 'DPM1', localPort: 3, remoteDevice: 'DPM2', remotePort: 1 }],
    leaves: [{ device: 'UL17_8_FIOM1', switchName: 'DPM1', port: 7 }],
    terminations: [{ device: 'DPM1', port: 3, linkUp: true, speedMbps: 1000, fullDuplex: true, mediaErrors: false }],
    ring: { closed: true, source: 'dlr', reason: 'Ring closed (Normal)' },
  }
}

describe('compareTopology', () => {
  it('all match + ring closed + clean terminations => healthy', () => {
    const v = compareTopology(base(), base())
    expect(v.healthy).toBe(true)
    expect(v.links.every(l => l.kind === 'match')).toBe(true)
  })

  it('right neighbor on wrong port => wrong-port, not healthy (the MTN6 case)', () => {
    const actual = base()
    actual.links[0].remotePort = 2 // drawn as 1
    const v = compareTopology(base(), actual)
    expect(v.healthy).toBe(false)
    expect(v.links.find(l => l.kind === 'wrong-port')).toBeTruthy()
  })

  it('different neighbor => wrong-neighbor', () => {
    const actual = base()
    actual.links[0].remoteDevice = 'DPM3'
    const v = compareTopology(base(), actual)
    expect(v.links.find(l => l.kind === 'wrong-neighbor')).toBeTruthy()
  })

  it('baseline link absent in actual => missing', () => {
    const actual = base()
    actual.links = []
    const v = compareTopology(base(), actual)
    expect(v.links.find(l => l.kind === 'missing')).toBeTruthy()
  })

  it('actual link not in baseline => unexpected', () => {
    const actual = base()
    actual.links.push({ localDevice: 'DPM2', localPort: 5, remoteDevice: 'DPM9', remotePort: 1 })
    const v = compareTopology(base(), actual)
    expect(v.links.find(l => l.kind === 'unexpected')).toBeTruthy()
  })

  it('media errors on a port => termination-fault, not healthy', () => {
    const actual = base()
    actual.terminations[0].mediaErrors = true
    const v = compareTopology(base(), actual)
    expect(v.healthy).toBe(false)
    expect(v.terminationFaults.length).toBe(1)
  })

  it('ring open => not healthy and ringClosed false', () => {
    const actual = base()
    actual.ring = { closed: false, source: 'dlr', reason: 'Ring Fault', breakBetween: ['DPM1', 'DPM2'] }
    const v = compareTopology(base(), actual)
    expect(v.healthy).toBe(false)
    expect(v.ringClosed).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run __tests__/ring-commissioning-compare.test.ts`
Expected: FAIL — `compareTopology` is not exported / module not found.

- [ ] **Step 4: Write the implementation**

```typescript
// lib/plc/network/ring-commissioning/compare.ts
import type { RingTopology, SwitchLink, LeafPlacement, PortTermination } from './types'

export type LinkVerdictKind =
  | 'match' | 'wrong-port' | 'wrong-neighbor' | 'missing' | 'unexpected' | 'termination-fault'

export interface LinkVerdict {
  kind: LinkVerdictKind
  expected?: SwitchLink | LeafPlacement
  actual?: SwitchLink | LeafPlacement
  detail: string
}

export interface RingCommissioningVerdict {
  healthy: boolean
  ringClosed: boolean
  ringReason: string
  links: LinkVerdict[]
  leafVerdicts: LinkVerdict[]
  terminationFaults: LinkVerdict[]
}

/** Undirected key so DPM1:3<->DPM2:1 matches regardless of read direction. */
function linkKey(l: SwitchLink): string {
  const a = `${l.localDevice}:${l.localPort}`
  const b = `${l.remoteDevice}:${l.remotePort}`
  return [a, b].sort().join('=')
}
/** Neighbor-only key (ignores ports) to detect right-neighbor/wrong-port. */
function neighborKey(l: SwitchLink): string {
  return [l.localDevice, l.remoteDevice].sort().join('=')
}

function diffLinks(expected: SwitchLink[], actual: SwitchLink[]): LinkVerdict[] {
  const out: LinkVerdict[] = []
  const actualByExact = new Map(actual.map(l => [linkKey(l), l]))
  const actualByNeighbor = new Map(actual.map(l => [neighborKey(l), l]))
  const matchedActual = new Set<string>()

  for (const exp of expected) {
    const exact = actualByExact.get(linkKey(exp))
    if (exact) {
      matchedActual.add(linkKey(exact))
      out.push({ kind: 'match', expected: exp, actual: exact, detail: `${exp.localDevice}:${exp.localPort} <-> ${exp.remoteDevice}:${exp.remotePort}` })
      continue
    }
    const byNeighbor = actualByNeighbor.get(neighborKey(exp))
    if (byNeighbor) {
      matchedActual.add(linkKey(byNeighbor))
      out.push({ kind: 'wrong-port', expected: exp, actual: byNeighbor, detail: `${exp.localDevice}<->${exp.remoteDevice}: drawn ${exp.localPort}/${exp.remotePort}, found ${byNeighbor.localPort}/${byNeighbor.remotePort}` })
      continue
    }
    out.push({ kind: 'missing', expected: exp, detail: `no cable found for ${exp.localDevice}:${exp.localPort} <-> ${exp.remoteDevice}:${exp.remotePort}` })
  }

  for (const act of actual) {
    if (matchedActual.has(linkKey(act))) continue
    // right-neighbor already surfaced as wrong-port; only flag genuinely new links
    const consumed = out.some(v => v.actual && linkKey(v.actual as SwitchLink) === linkKey(act))
    if (!consumed) {
      out.push({ kind: 'unexpected', actual: act, detail: `unexpected cable ${act.localDevice}:${act.localPort} <-> ${act.remoteDevice}:${act.remotePort}` })
    }
  }
  return out
}

function leafKey(l: LeafPlacement): string { return `${l.device}` }

function diffLeaves(expected: LeafPlacement[], actual: LeafPlacement[]): LinkVerdict[] {
  const out: LinkVerdict[] = []
  const actualByDevice = new Map(actual.map(l => [leafKey(l), l]))
  const seen = new Set<string>()
  for (const exp of expected) {
    const act = actualByDevice.get(leafKey(exp))
    if (!act) { out.push({ kind: 'missing', expected: exp, detail: `${exp.device} not found on any switch port` }); continue }
    seen.add(leafKey(act))
    if (act.switchName === exp.switchName && act.port === exp.port) {
      out.push({ kind: 'match', expected: exp, actual: act, detail: `${exp.device} on ${exp.switchName}:${exp.port}` })
    } else {
      out.push({ kind: 'wrong-port', expected: exp, actual: act, detail: `${exp.device}: drawn ${exp.switchName}:${exp.port}, found ${act.switchName}:${act.port}` })
    }
  }
  for (const act of actual) {
    if (!seen.has(leafKey(act))) out.push({ kind: 'unexpected', actual: act, detail: `unexpected device ${act.device} on ${act.switchName}:${act.port}` })
  }
  return out
}

function terminationFaults(terms: PortTermination[]): LinkVerdict[] {
  return terms
    .filter(t => t.linkUp && (t.mediaErrors || !t.fullDuplex || (t.speedMbps > 0 && t.speedMbps < 100)))
    .map(t => ({
      kind: 'termination-fault' as const,
      detail: `${t.device}:${t.port} — ${[t.mediaErrors && 'media errors', !t.fullDuplex && 'half-duplex', t.speedMbps > 0 && t.speedMbps < 100 && `${t.speedMbps}Mbps`].filter(Boolean).join(', ')}`,
    }))
}

export function compareTopology(baseline: RingTopology, actual: RingTopology): RingCommissioningVerdict {
  const links = diffLinks(baseline.links, actual.links)
  const leafVerdicts = diffLeaves(baseline.leaves, actual.leaves)
  const tFaults = terminationFaults(actual.terminations)
  const ringClosed = actual.ring.closed
  const badLink = links.some(l => l.kind !== 'match') || leafVerdicts.some(l => l.kind !== 'match')
  const healthy = ringClosed && !badLink && tFaults.length === 0
  return {
    healthy,
    ringClosed,
    ringReason: actual.ring.reason,
    links,
    leafVerdicts,
    terminationFaults: tFaults,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/ring-commissioning-compare.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/plc/network/ring-commissioning/types.ts lib/plc/network/ring-commissioning/compare.ts __tests__/ring-commissioning-compare.test.ts
git commit -m "feat(ring): pure verdict engine for ring-commissioning (types + compare)"
```

---

### Task 2: SNMP MIB constants + LLDP/FDB parsers

Pure translation of SNMP walk results (OID→value rows) into `SwitchLink[]` and `LeafPlacement[]`. No network I/O — fed fixture rows.

**Files:**
- Create: `lib/plc/network/ring-commissioning/snmp/mibs.ts`
- Create: `lib/plc/network/ring-commissioning/snmp/parse.ts`
- Test: `__tests__/ring-commissioning-snmp-parse.test.ts`

**Interfaces:**
- Consumes: `SwitchLink`, `LeafPlacement` from Task 1 `types.ts`.
- Produces:
  - `mibs.ts` exports OID string constants: `OID.lldpRemChassisId = '1.0.8802.1.1.2.1.4.1.1.5'`, `OID.lldpRemPortId = '1.0.8802.1.1.2.1.4.1.1.7'`, `OID.lldpLocPortDesc = '1.0.8802.1.1.2.1.3.7.1.4'`, `OID.dot1dTpFdbPort = '1.3.6.1.2.1.17.4.3.1.2'`, `OID.dot1dBasePortIfIndex = '1.3.6.1.2.1.17.1.4.1.2'`, `OID.moxaTurboRingState = '1.3.6.1.4.1.8691.7.x'` (placeholder value documented as needing the Moxa MIB from the linked manual — see note), `OID.hmMrpMRMRealRingState = '1.3.6.1.4.1.248.14.5.3.1.25'`.
  - `parse.ts` exports `interface SnmpRow { oid: string; value: string }`, `parseLldpNeighbors(rows: SnmpRow[], localDevice: string, resolveChassis: (id: string) => string): SwitchLink[]`, `parseFdb(rows: SnmpRow[], switchName: string, portIfIndex: Map<number, number>, resolveMac: (mac: string) => string | null): LeafPlacement[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/ring-commissioning-snmp-parse.test.ts
import { describe, it, expect } from 'vitest'
import { parseLldpNeighbors, parseFdb, type SnmpRow } from '@/lib/plc/network/ring-commissioning/snmp/parse'
import { OID } from '@/lib/plc/network/ring-commissioning/snmp/mibs'

describe('parseLldpNeighbors', () => {
  it('turns lldpRem rows into SwitchLinks, resolving chassis-id to a device name', () => {
    // index scheme: <timemark>.<localPort>.<remoteIndex>
    const rows: SnmpRow[] = [
      { oid: `${OID.lldpRemChassisId}.0.3.1`, value: 'aa:bb:cc:00:00:02' },
      { oid: `${OID.lldpRemPortId}.0.3.1`, value: '1' },
    ]
    const links = parseLldpNeighbors(rows, 'DPM1', (chassis) => chassis === 'aa:bb:cc:00:00:02' ? 'DPM2' : chassis)
    expect(links).toEqual([{ localDevice: 'DPM1', localPort: 3, remoteDevice: 'DPM2', remotePort: 1 }])
  })
})

describe('parseFdb', () => {
  it('maps a learned MAC on a bridge port to a leaf device on the physical port', () => {
    const rows: SnmpRow[] = [
      // dot1dTpFdbPort indexed by decimal MAC; value = bridge port number
      { oid: `${OID.dot1dTpFdbPort}.0.26.187.0.0.9`, value: '7' },
    ]
    const portIfIndex = new Map<number, number>([[7, 7]]) // bridge port 7 -> phys port 7
    const leaves = parseFdb(rows, 'DPM1', portIfIndex, (mac) => mac === '00:1a:bb:00:00:09' ? 'UL17_8_FIOM1' : null)
    expect(leaves).toEqual([{ device: 'UL17_8_FIOM1', switchName: 'DPM1', port: 7 }])
  })

  it('drops MACs that resolve to no known device', () => {
    const rows: SnmpRow[] = [{ oid: `${OID.dot1dTpFdbPort}.0.0.0.0.0.1`, value: '5' }]
    expect(parseFdb(rows, 'DPM1', new Map([[5, 5]]), () => null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/ring-commissioning-snmp-parse.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `mibs.ts`**

```typescript
// lib/plc/network/ring-commissioning/snmp/mibs.ts
/**
 * SNMP OID constants for ring-commissioning reads. Standard MIBs are exact.
 * Vendor ring-state OIDs: MRP is confirmed (Hirschmann HMRING MIB); the Moxa
 * Turbo Ring OID is a documented PLACEHOLDER — fill from the Moxa Industrial
 * Protocols manual (moxa.com .../moxa-industrial-protocol-users-guide-manual-v6.6.pdf)
 * against real MTN6 hardware. Until then the Moxa adapter reports ring source
 * 'moxa' with closed:false/reason 'Moxa ring OID unconfigured' (never false-green).
 */
export const OID = {
  // LLDP-MIB (IEEE 802.1AB) — remote systems table
  lldpRemChassisId: '1.0.8802.1.1.2.1.4.1.1.5',
  lldpRemPortId: '1.0.8802.1.1.2.1.4.1.1.7',
  lldpLocPortDesc: '1.0.8802.1.1.2.1.3.7.1.4',
  // BRIDGE-MIB — forwarding database + port mapping
  dot1dTpFdbPort: '1.3.6.1.2.1.17.4.3.1.2',
  dot1dBasePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
  // Vendor ring state
  hmMrpMRMRealRingState: '1.3.6.1.4.1.248.14.5.3.1.25', // open(1)/closed(2)/undefined(3)
  moxaTurboRingState: '', // PLACEHOLDER — see file header; empty => Moxa adapter self-reports unconfigured
} as const
```

- [ ] **Step 4: Write `parse.ts`**

```typescript
// lib/plc/network/ring-commissioning/snmp/parse.ts
import type { SwitchLink, LeafPlacement } from '../types'
import { OID } from './mibs'

export interface SnmpRow { oid: string; value: string }

/** Strip a base OID prefix and return the trailing index numbers. */
function indexOf(oid: string, base: string): number[] {
  if (!oid.startsWith(base + '.')) return []
  return oid.slice(base.length + 1).split('.').map(Number)
}

/**
 * LLDP remote table is indexed .<timeMark>.<lldpLocPortNum>.<lldpRemIndex>.
 * We pair lldpRemChassisId (the neighbor identity) with lldpRemPortId (the
 * neighbor's port) at the same index, resolve the chassis id to a device name,
 * and emit one SwitchLink per neighbor entry.
 */
export function parseLldpNeighbors(
  rows: SnmpRow[], localDevice: string, resolveChassis: (chassisId: string) => string,
): SwitchLink[] {
  const chassis = new Map<string, string>()
  const remPort = new Map<string, string>()
  for (const r of rows) {
    const ci = indexOf(r.oid, OID.lldpRemChassisId)
    if (ci.length === 3) { chassis.set(ci.join('.'), r.value); continue }
    const pi = indexOf(r.oid, OID.lldpRemPortId)
    if (pi.length === 3) remPort.set(pi.join('.'), r.value)
  }
  const links: SwitchLink[] = []
  for (const [idx, chassisId] of chassis) {
    const localPort = Number(idx.split('.')[1])
    const remotePortRaw = remPort.get(idx)
    const remotePort = remotePortRaw != null ? Number(remotePortRaw) : NaN
    if (!Number.isFinite(localPort) || !Number.isFinite(remotePort)) continue
    links.push({ localDevice, localPort, remoteDevice: resolveChassis(chassisId), remotePort })
  }
  return links
}

/** Format the 6 trailing index bytes of a dot1dTpFdbPort OID as a MAC string. */
function macFromIndex(idx: number[]): string {
  return idx.slice(-6).map(b => b.toString(16).padStart(2, '0')).join(':')
}

/**
 * dot1dTpFdbPort is indexed by the 6-byte MAC (decimal), value = bridge port.
 * We map bridge port -> physical port via portIfIndex, resolve the MAC to a
 * known device, and emit one LeafPlacement per resolvable entry.
 */
export function parseFdb(
  rows: SnmpRow[], switchName: string, portIfIndex: Map<number, number>,
  resolveMac: (mac: string) => string | null,
): LeafPlacement[] {
  const out: LeafPlacement[] = []
  for (const r of rows) {
    const idx = indexOf(r.oid, OID.dot1dTpFdbPort)
    if (idx.length < 6) continue
    const bridgePort = Number(r.value)
    const phys = portIfIndex.get(bridgePort) ?? bridgePort
    const device = resolveMac(macFromIndex(idx))
    if (!device) continue
    out.push({ device, switchName, port: phys })
  }
  return out
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/ring-commissioning-snmp-parse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/plc/network/ring-commissioning/snmp/mibs.ts lib/plc/network/ring-commissioning/snmp/parse.ts __tests__/ring-commissioning-snmp-parse.test.ts
git commit -m "feat(ring): SNMP MIB OIDs + pure LLDP/FDB parsers"
```

---

### Task 3: Lazy, fail-safe SNMP client

Wraps `net-snmp` behind a lazy `require`. Exposes `get`/`subtree` (walk) with a hard timeout. Never throws; on load failure returns `{ available:false }`.

**Files:**
- Create: `lib/plc/network/ring-commissioning/snmp/client.ts`
- Test: `__tests__/ring-commissioning-snmp-client.test.ts`
- Modify: `package.json` (add `net-snmp` to dependencies)

**Interfaces:**
- Consumes: `SnmpRow` from Task 2 `parse.ts`.
- Produces: `interface SnmpCreds { version: 'v2c'|'v3'; community?: string; port?: number; timeoutMs?: number; retries?: number }`, `type SnmpReadResult = { available: true; rows: SnmpRow[] } | { available: false; reason: string }`, `async function snmpWalk(host: string, oid: string, creds: SnmpCreds): Promise<SnmpReadResult>`, `async function snmpGet(host: string, oids: string[], creds: SnmpCreds): Promise<SnmpReadResult>`, and `function loadNetSnmp(): { ok: true; mod: any } | { ok: false; reason: string }` (exported for testing the load-failure path).

- [ ] **Step 1: Add the dependency**

Run: `npm install net-snmp@^3`
Expected: `net-snmp` appears in `package.json` dependencies. (Pure-JS; no native build step.)

- [ ] **Step 2: Write the failing test**

```typescript
// __tests__/ring-commissioning-snmp-client.test.ts
import { describe, it, expect } from 'vitest'
import { snmpWalk } from '@/lib/plc/network/ring-commissioning/snmp/client'

describe('snmpWalk', () => {
  it('returns available:false with a reason for an unreachable host (never throws)', async () => {
    const res = await snmpWalk('192.0.2.1', '1.3.6.1.2.1.1.1', { version: 'v2c', community: 'public', timeoutMs: 300, retries: 0 })
    expect(res.available).toBe(false)
    if (!res.available) expect(typeof res.reason).toBe('string')
  }, 5000)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run __tests__/ring-commissioning-snmp-client.test.ts`
Expected: FAIL — `client` module not found.

- [ ] **Step 4: Write `client.ts`**

```typescript
// lib/plc/network/ring-commissioning/snmp/client.ts
import type { SnmpRow } from './parse'

export interface SnmpCreds {
  version: 'v2c' | 'v3'
  community?: string
  port?: number
  timeoutMs?: number
  retries?: number
}
export type SnmpReadResult = { available: true; rows: SnmpRow[] } | { available: false; reason: string }

/** Lazy, guarded load of the optional net-snmp dependency. */
export function loadNetSnmp(): { ok: true; mod: any } | { ok: false; reason: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('net-snmp')
    return { ok: true, mod }
  } catch (e) {
    return { ok: false, reason: `net-snmp unavailable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function openSession(mod: any, host: string, creds: SnmpCreds): any {
  return mod.createSession(host, creds.community ?? 'public', {
    port: creds.port ?? 161,
    timeout: creds.timeoutMs ?? 2000,
    retries: creds.retries ?? 1,
    version: mod.Version2c,
  })
}

/** Walk a subtree; resolves (never rejects) to rows or a reason. */
export function snmpWalk(host: string, oid: string, creds: SnmpCreds): Promise<SnmpReadResult> {
  const loaded = loadNetSnmp()
  if (!loaded.ok) return Promise.resolve({ available: false, reason: loaded.reason })
  return new Promise((resolve) => {
    let session: any
    const rows: SnmpRow[] = []
    let done = false
    const finish = (r: SnmpReadResult) => { if (done) return; done = true; try { session?.close() } catch { /* noop */ } resolve(r) }
    const guard = setTimeout(() => finish({ available: false, reason: `SNMP walk timed out for ${host}` }), (creds.timeoutMs ?? 2000) * 4)
    try {
      const mod = loaded.mod
      session = openSession(mod, host, creds)
      session.subtree(oid, 20,
        (varbinds: any[]) => {
          for (const vb of varbinds) {
            if (mod.isVarbindError(vb)) continue
            rows.push({ oid: vb.oid, value: String(vb.value) })
          }
        },
        (error: any) => { clearTimeout(guard); finish(error ? { available: false, reason: String(error.message ?? error) } : { available: true, rows }) },
      )
    } catch (e) {
      clearTimeout(guard)
      finish({ available: false, reason: e instanceof Error ? e.message : String(e) })
    }
  })
}

/** GET a fixed set of OIDs; resolves (never rejects). */
export function snmpGet(host: string, oids: string[], creds: SnmpCreds): Promise<SnmpReadResult> {
  const loaded = loadNetSnmp()
  if (!loaded.ok) return Promise.resolve({ available: false, reason: loaded.reason })
  return new Promise((resolve) => {
    let session: any
    try {
      const mod = loaded.mod
      session = openSession(mod, host, creds)
      session.get(oids, (error: any, varbinds: any[]) => {
        try { session.close() } catch { /* noop */ }
        if (error) return resolve({ available: false, reason: String(error.message ?? error) })
        const rows: SnmpRow[] = []
        for (const vb of varbinds ?? []) {
          if (mod.isVarbindError(vb)) continue
          rows.push({ oid: vb.oid, value: String(vb.value) })
        }
        resolve({ available: true, rows })
      })
    } catch (e) {
      try { session?.close() } catch { /* noop */ }
      resolve({ available: false, reason: e instanceof Error ? e.message : String(e) })
    }
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/ring-commissioning-snmp-client.test.ts`
Expected: PASS (returns `available:false` within the timeout, no throw).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/plc/network/ring-commissioning/snmp/client.ts __tests__/ring-commissioning-snmp-client.test.ts
git commit -m "feat(ring): lazy fail-safe net-snmp client (walk/get, never throws)"
```

---

### Task 4: Vendor adapters + selection

Turns raw SNMP reads into topology fragments, choosing the ring-state source per vendor. Selection + ring-state decode are pure-tested; the read wiring is thin.

**Files:**
- Create: `lib/plc/network/ring-commissioning/snmp/adapters/index.ts`
- Create: `lib/plc/network/ring-commissioning/snmp/adapters/generic.ts`
- Create: `lib/plc/network/ring-commissioning/snmp/adapters/moxa.ts`
- Create: `lib/plc/network/ring-commissioning/snmp/adapters/hirschmann.ts`
- Test: `__tests__/ring-commissioning-adapters.test.ts`

**Interfaces:**
- Consumes: `SnmpRow` (Task 2), `RingState` (Task 1), `OID` (Task 2).
- Produces:
  - `index.ts` exports `type Vendor = 'moxa' | 'hirschmann' | 'generic'`, `function selectVendor(deviceName: string, hint?: string): Vendor`, and `function decodeRingState(vendor: Vendor, rows: SnmpRow[]): RingState`.
  - `hirschmann.ts` exports `function decodeMrpRingState(rows: SnmpRow[]): RingState`.
  - `moxa.ts` exports `function decodeTurboRingState(rows: SnmpRow[]): RingState`.
  - `generic.ts` exports `function noRingState(): RingState`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/ring-commissioning-adapters.test.ts
import { describe, it, expect } from 'vitest'
import { selectVendor, decodeRingState } from '@/lib/plc/network/ring-commissioning/snmp/adapters'
import { OID } from '@/lib/plc/network/ring-commissioning/snmp/mibs'

describe('selectVendor', () => {
  it('classifies by name hint, defaulting to generic', () => {
    expect(selectVendor('MTN6_SW1', 'moxa')).toBe('moxa')
    expect(selectVendor('UL17_8_DPM1')).toBe('hirschmann') // DPM = Hirschmann Octopus
    expect(selectVendor('SOME_SWITCH')).toBe('generic')
  })
})

describe('decodeRingState', () => {
  it('MRP closed(2) => closed ring', () => {
    const rows = [{ oid: `${OID.hmMrpMRMRealRingState}.0`, value: '2' }]
    const s = decodeRingState('hirschmann', rows)
    expect(s.source).toBe('mrp')
    expect(s.closed).toBe(true)
  })
  it('MRP open(1) => open ring', () => {
    const rows = [{ oid: `${OID.hmMrpMRMRealRingState}.0`, value: '1' }]
    expect(decodeRingState('hirschmann', rows).closed).toBe(false)
  })
  it('Moxa with no configured OID => reported but not false-green', () => {
    const s = decodeRingState('moxa', [])
    expect(s.source).toBe('moxa')
    expect(s.closed).toBe(false)
  })
  it('generic => source none, never green', () => {
    expect(decodeRingState('generic', []).closed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/ring-commissioning-adapters.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the adapter files**

```typescript
// lib/plc/network/ring-commissioning/snmp/adapters/generic.ts
import type { RingState } from '../../types'
export function noRingState(): RingState {
  return { closed: false, source: 'none', reason: 'No vendor ring-state source (use DLR or configure a vendor OID)' }
}
```

```typescript
// lib/plc/network/ring-commissioning/snmp/adapters/hirschmann.ts
import type { RingState } from '../../types'
import type { SnmpRow } from '../parse'
import { OID } from '../mibs'
/** hmMrpMRMRealRingState: open(1) / closed(2) / undefined(3). */
export function decodeMrpRingState(rows: SnmpRow[]): RingState {
  const row = rows.find(r => r.oid.startsWith(OID.hmMrpMRMRealRingState))
  if (!row) return { closed: false, source: 'mrp', reason: 'MRP ring state unreadable' }
  const v = Number(row.value)
  if (v === 2) return { closed: true, source: 'mrp', reason: 'MRP ring closed (redundancy intact)' }
  if (v === 1) return { closed: false, source: 'mrp', reason: 'MRP ring OPEN' }
  return { closed: false, source: 'mrp', reason: `MRP ring state ${v} (undefined)` }
}
```

```typescript
// lib/plc/network/ring-commissioning/snmp/adapters/moxa.ts
import type { RingState } from '../../types'
import type { SnmpRow } from '../parse'
import { OID } from '../mibs'
/** Moxa Turbo Ring. OID is a documented placeholder until confirmed on MTN6
 *  hardware from the Moxa manual — until then never report a green ring. */
export function decodeTurboRingState(rows: SnmpRow[]): RingState {
  if (!OID.moxaTurboRingState) {
    return { closed: false, source: 'moxa', reason: 'Moxa Turbo Ring OID unconfigured — confirm on hardware' }
  }
  const row = rows.find(r => r.oid.startsWith(OID.moxaTurboRingState))
  if (!row) return { closed: false, source: 'moxa', reason: 'Moxa ring state unreadable' }
  // Moxa healthy state value TBD-from-hardware; treat documented healthy code here.
  const v = Number(row.value)
  return v === 1
    ? { closed: true, source: 'moxa', reason: 'Turbo Ring healthy' }
    : { closed: false, source: 'moxa', reason: `Turbo Ring state ${v}` }
}
```

```typescript
// lib/plc/network/ring-commissioning/snmp/adapters/index.ts
import type { RingState } from '../../types'
import type { SnmpRow } from '../parse'
import { decodeMrpRingState } from './hirschmann'
import { decodeTurboRingState } from './moxa'
import { noRingState } from './generic'

export type Vendor = 'moxa' | 'hirschmann' | 'generic'

/** Pick a vendor from an explicit hint, else the device naming, else generic. */
export function selectVendor(deviceName: string, hint?: string): Vendor {
  const h = (hint ?? '').toLowerCase()
  if (h.includes('moxa')) return 'moxa'
  if (h.includes('hirschmann') || h.includes('octopus')) return 'hirschmann'
  if (/moxa/i.test(deviceName)) return 'moxa'
  if (/(^|_)DPM\d*/i.test(deviceName)) return 'hirschmann' // DPM = Hirschmann Octopus
  return 'generic'
}

export function decodeRingState(vendor: Vendor, rows: SnmpRow[]): RingState {
  if (vendor === 'hirschmann') return decodeMrpRingState(rows)
  if (vendor === 'moxa') return decodeTurboRingState(rows)
  return noRingState()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/ring-commissioning-adapters.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/plc/network/ring-commissioning/snmp/adapters __tests__/ring-commissioning-adapters.test.ts
git commit -m "feat(ring): vendor adapters (MRP/Turbo Ring/generic) + selection"
```

---

### Task 5: Capture orchestration

Assembles an `ActualTopology` for a ring from: switch list (from `NetworkNodes`), SNMP LLDP+FDB reads (Tasks 2–4), the existing DLR read, and existing `0xF6` terminations. The pure assembly `assembleTopology` is unit-tested with injected data; the impure `captureRing` wires the real readers.

**Files:**
- Create: `lib/plc/network/ring-commissioning/capture.ts`
- Test: `__tests__/ring-commissioning-capture.test.ts`

**Interfaces:**
- Consumes: `RingTopology`, `SwitchLink`, `LeafPlacement`, `PortTermination`, `RingState` (Task 1); `snmpWalk` (Task 3); `parseLldpNeighbors`, `parseFdb` (Task 2); `selectVendor`, `decodeRingState` (Task 4).
- Produces:
  - `interface SwitchTarget { name: string; ip: string; vendorHint?: string }`
  - `interface CaptureInputs { links: SwitchLink[]; leaves: LeafPlacement[]; terminations: PortTermination[]; ring: RingState }`
  - `function assembleTopology(i: CaptureInputs): RingTopology` (pure)
  - `async function captureRing(switches: SwitchTarget[], creds: SnmpCreds, deps: CaptureDeps): Promise<{ ok: true; topology: RingTopology } | { ok: false; reason: string }>` where `CaptureDeps` injects the readers (DLR result, termination provider) so it stays testable and isolated.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/ring-commissioning-capture.test.ts
import { describe, it, expect } from 'vitest'
import { assembleTopology } from '@/lib/plc/network/ring-commissioning/capture'

describe('assembleTopology', () => {
  it('dedupes reverse-direction LLDP links and carries ring + terminations', () => {
    const t = assembleTopology({
      links: [
        { localDevice: 'DPM1', localPort: 3, remoteDevice: 'DPM2', remotePort: 1 },
        { localDevice: 'DPM2', localPort: 1, remoteDevice: 'DPM1', remotePort: 3 }, // reverse dup
      ],
      leaves: [{ device: 'FIOM1', switchName: 'DPM1', port: 7 }],
      terminations: [{ device: 'DPM1', port: 3, linkUp: true, speedMbps: 1000, fullDuplex: true, mediaErrors: false }],
      ring: { closed: true, source: 'dlr', reason: 'Ring closed (Normal)' },
    })
    expect(t.links.length).toBe(1)
    expect(t.leaves.length).toBe(1)
    expect(t.ring.closed).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/ring-commissioning-capture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `capture.ts`**

```typescript
// lib/plc/network/ring-commissioning/capture.ts
import type { RingTopology, SwitchLink, LeafPlacement, PortTermination, RingState } from './types'
import type { SnmpCreds, SnmpReadResult } from './snmp/client'
import { snmpWalk } from './snmp/client'
import { OID } from './snmp/mibs'
import { parseLldpNeighbors, parseFdb } from './snmp/parse'
import { selectVendor, decodeRingState } from './snmp/adapters'

export interface SwitchTarget { name: string; ip: string; vendorHint?: string }
export interface CaptureInputs { links: SwitchLink[]; leaves: LeafPlacement[]; terminations: PortTermination[]; ring: RingState }

/** Injected side-reads so captureRing stays isolated + testable. */
export interface CaptureDeps {
  /** Resolve an LLDP chassis-id to a known device name (from NetworkNodes). */
  resolveChassis: (chassisId: string) => string
  /** Resolve a learned MAC to a known leaf device, or null. */
  resolveMac: (mac: string) => string | null
  /** Bridge-port -> physical-port map per switch (empty => identity). */
  portIfIndex: (switchName: string) => Map<number, number>
  /** The DLR ring result if a supervisor is present (else null). */
  dlrRing: RingState | null
  /** Existing 0xF6-derived terminations for the ring's ports. */
  terminations: () => PortTermination[]
  /** Override the SNMP walk (tests inject fakes). */
  walk?: (host: string, oid: string, creds: SnmpCreds) => Promise<SnmpReadResult>
}

function dedupeLinks(links: SwitchLink[]): SwitchLink[] {
  const seen = new Set<string>()
  const out: SwitchLink[] = []
  for (const l of links) {
    const key = [`${l.localDevice}:${l.localPort}`, `${l.remoteDevice}:${l.remotePort}`].sort().join('=')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}

/** Pure assembly: dedupe links, pass through leaves/terminations/ring. */
export function assembleTopology(i: CaptureInputs): RingTopology {
  return { links: dedupeLinks(i.links), leaves: i.leaves, terminations: i.terminations, ring: i.ring }
}

export async function captureRing(
  switches: SwitchTarget[], creds: SnmpCreds, deps: CaptureDeps,
): Promise<{ ok: true; topology: RingTopology } | { ok: false; reason: string }> {
  const walk = deps.walk ?? snmpWalk
  const links: SwitchLink[] = []
  const leaves: LeafPlacement[] = []
  let anyRead = false
  let vendorRingRows: { vendor: ReturnType<typeof selectVendor>; rows: SnmpReadResult } | null = null

  for (const sw of switches) {
    const lldp = await walk(sw.ip, OID.lldpRemChassisId, creds)
    const lldpPorts = await walk(sw.ip, OID.lldpRemPortId, creds)
    if (lldp.available && lldpPorts.available) {
      anyRead = true
      links.push(...parseLldpNeighbors([...lldp.rows, ...lldpPorts.rows], sw.name, deps.resolveChassis))
    }
    const fdb = await walk(sw.ip, OID.dot1dTpFdbPort, creds)
    if (fdb.available) {
      anyRead = true
      leaves.push(...parseFdb(fdb.rows, sw.name, deps.portIfIndex(sw.name), deps.resolveMac))
    }
    // Read vendor ring-state from the first switch only (single-point read).
    if (!vendorRingRows) {
      const vendor = selectVendor(sw.name, sw.vendorHint)
      if (vendor === 'hirschmann') vendorRingRows = { vendor, rows: await walk(sw.ip, OID.hmMrpMRMRealRingState, creds) }
      else if (vendor === 'moxa' && OID.moxaTurboRingState) vendorRingRows = { vendor, rows: await walk(sw.ip, OID.moxaTurboRingState, creds) }
      else vendorRingRows = { vendor, rows: { available: true, rows: [] } }
    }
  }

  // Ring verdict: prefer DLR (already proven); else the vendor MIB.
  const ring: RingState = deps.dlrRing
    ?? (vendorRingRows ? decodeRingState(vendorRingRows.vendor, vendorRingRows.rows.available ? vendorRingRows.rows.rows : []) : { closed: false, source: 'none', reason: 'No ring source' })

  if (!anyRead && !deps.dlrRing) {
    return { ok: false, reason: 'No switch responded to SNMP and no DLR supervisor present — check SNMP config/reachability, or run on-site.' }
  }
  return { ok: true, topology: assembleTopology({ links, leaves, terminations: deps.terminations(), ring }) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/ring-commissioning-capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/plc/network/ring-commissioning/capture.ts __tests__/ring-commissioning-capture.test.ts
git commit -m "feat(ring): capture orchestration (assemble + isolated captureRing)"
```

---

### Task 6: Baseline table + repository

Additive SQLite table and a small repo to save/fetch the approved baseline. Tested against a temp DB.

**Files:**
- Create: `lib/plc/network/ring-commissioning/baseline-repo.ts`
- Modify: `lib/db-sqlite.ts` (add the `CREATE TABLE IF NOT EXISTS RingBaselines` block inside the existing schema-init function, alongside the `NetworkPorts` create around line 452)
- Test: `__tests__/ring-commissioning-baseline-repo.test.ts`

**Interfaces:**
- Consumes: `RingBaseline`, `RingTopology` (Task 1).
- Produces: `function saveBaseline(dbConn: Database, b: RingBaseline): void`, `function getBaseline(dbConn: Database, subsystemId: number, ringName: string): RingBaseline | null`, `function listBaselines(dbConn: Database, subsystemId: number): RingBaseline[]` — where `Database` is the `better-sqlite3` type. The repo takes the db connection as a parameter (no import-time singleton) so it is testable with a temp DB.

- [ ] **Step 1: Add the table to `db-sqlite.ts`**

Locate the `CREATE TABLE IF NOT EXISTS NetworkPorts (...)` statement (~line 452) and add immediately after it:

```sql
    CREATE TABLE IF NOT EXISTS RingBaselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      RingName TEXT NOT NULL,
      CapturedAt TEXT NOT NULL,
      ApprovedBy TEXT,
      ApprovedAt TEXT,
      TopologyJson TEXT NOT NULL,
      CreatedAt TEXT DEFAULT (datetime('now')),
      UNIQUE(SubsystemId, RingName)
    );
```

- [ ] **Step 2: Write the failing test**

```typescript
// __tests__/ring-commissioning-baseline-repo.test.ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { saveBaseline, getBaseline, listBaselines } from '@/lib/plc/network/ring-commissioning/baseline-repo'
import type { RingBaseline } from '@/lib/plc/network/ring-commissioning/types'

function tempDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE RingBaselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER NOT NULL, RingName TEXT NOT NULL,
    CapturedAt TEXT NOT NULL, ApprovedBy TEXT, ApprovedAt TEXT, TopologyJson TEXT NOT NULL,
    CreatedAt TEXT DEFAULT (datetime('now')), UNIQUE(SubsystemId, RingName))`)
  return db
}
function sample(): RingBaseline {
  return {
    subsystemId: 40, ringName: 'CDW5 Ring', capturedAt: '2026-07-08T00:00:00Z',
    approvedBy: 'ilia', approvedAt: '2026-07-08T00:05:00Z',
    topology: { links: [], leaves: [], terminations: [], ring: { closed: true, source: 'dlr', reason: 'ok' } },
  }
}

describe('baseline-repo', () => {
  it('saves and reads back a baseline', () => {
    const db = tempDb()
    saveBaseline(db, sample())
    const got = getBaseline(db, 40, 'CDW5 Ring')
    expect(got?.approvedBy).toBe('ilia')
    expect(got?.topology.ring.closed).toBe(true)
  })
  it('re-saving the same ring replaces (upsert)', () => {
    const db = tempDb()
    saveBaseline(db, sample())
    saveBaseline(db, { ...sample(), approvedBy: 'nika' })
    expect(getBaseline(db, 40, 'CDW5 Ring')?.approvedBy).toBe('nika')
    expect(listBaselines(db, 40).length).toBe(1)
  })
  it('getBaseline returns null when absent', () => {
    expect(getBaseline(tempDb(), 1, 'none')).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run __tests__/ring-commissioning-baseline-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `baseline-repo.ts`**

```typescript
// lib/plc/network/ring-commissioning/baseline-repo.ts
import type { Database } from 'better-sqlite3'
import type { RingBaseline, RingTopology } from './types'

interface Row {
  SubsystemId: number; RingName: string; CapturedAt: string
  ApprovedBy: string | null; ApprovedAt: string | null; TopologyJson: string
}

function toBaseline(r: Row): RingBaseline {
  return {
    subsystemId: r.SubsystemId, ringName: r.RingName, capturedAt: r.CapturedAt,
    approvedBy: r.ApprovedBy, approvedAt: r.ApprovedAt,
    topology: JSON.parse(r.TopologyJson) as RingTopology,
  }
}

export function saveBaseline(db: Database, b: RingBaseline): void {
  db.prepare(`
    INSERT INTO RingBaselines (SubsystemId, RingName, CapturedAt, ApprovedBy, ApprovedAt, TopologyJson)
    VALUES (@SubsystemId, @RingName, @CapturedAt, @ApprovedBy, @ApprovedAt, @TopologyJson)
    ON CONFLICT(SubsystemId, RingName) DO UPDATE SET
      CapturedAt=excluded.CapturedAt, ApprovedBy=excluded.ApprovedBy,
      ApprovedAt=excluded.ApprovedAt, TopologyJson=excluded.TopologyJson
  `).run({
    SubsystemId: b.subsystemId, RingName: b.ringName, CapturedAt: b.capturedAt,
    ApprovedBy: b.approvedBy, ApprovedAt: b.approvedAt, TopologyJson: JSON.stringify(b.topology),
  })
}

export function getBaseline(db: Database, subsystemId: number, ringName: string): RingBaseline | null {
  const r = db.prepare('SELECT * FROM RingBaselines WHERE SubsystemId=? AND RingName=?').get(subsystemId, ringName) as Row | undefined
  return r ? toBaseline(r) : null
}

export function listBaselines(db: Database, subsystemId: number): RingBaseline[] {
  const rows = db.prepare('SELECT * FROM RingBaselines WHERE SubsystemId=? ORDER BY RingName').all(subsystemId) as Row[]
  return rows.map(toBaseline)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/ring-commissioning-baseline-repo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/db-sqlite.ts lib/plc/network/ring-commissioning/baseline-repo.ts __tests__/ring-commissioning-baseline-repo.test.ts
git commit -m "feat(ring): additive RingBaselines table + baseline repo (upsert)"
```

---

### Task 7: Config field + API routes

Adds the optional `snmp` config block and three wrapped, on-demand route handlers. Handlers gather switch targets from `NetworkNodes`, run capture/compare, and persist the approved baseline. Every failure path returns HTTP 200 `{ ok:false, reason }`.

**Files:**
- Modify: `lib/config/types.ts` (add optional `snmp?: SnmpConfig` to `AppConfig` + export `SnmpConfig`)
- Create: `app/api/network/ring/capture/route.ts`
- Create: `app/api/network/ring/baseline/route.ts`
- Create: `app/api/network/ring/check/route.ts`
- Modify: `routes/index.ts` (import + mount the three routes in the `/api/network` block ~line 315)
- Create: `lib/plc/network/ring-commissioning/resolve-targets.ts` (build `SwitchTarget[]` + resolver maps from `NetworkNodes`/`NetworkPorts` for a subsystem)
- Test: `__tests__/ring-commissioning-resolve-targets.test.ts`

**Interfaces:**
- Consumes: `captureRing`, `SwitchTarget`, `CaptureDeps` (Task 5); `compareTopology` (Task 1); `saveBaseline`/`getBaseline` (Task 6); `readDlrStatus`+`ringVerdict`+`deriveDlrPath` (existing `dlr.ts`); `getLatestRingStatus`/network snapshots from the poller for terminations.
- Produces:
  - `types.ts`: `export interface SnmpConfig { enabled: boolean; version: 'v2c'|'v3'; community?: string; port?: number; timeoutMs?: number; retries?: number }`.
  - `resolve-targets.ts`: `function resolveSwitchTargets(db, subsystemId): { ringName: string; switches: SwitchTarget[]; resolveChassis: (id:string)=>string; resolveMac: (mac:string)=>string|null }[]` (pure over injected db rows via a thin query).
  - Route contract (all POST/GET return `{ ok: boolean, ... }`):
    - `POST /api/network/ring/capture` body `{ subsystemId }` → `{ ok, ring?: { ringName, topology }, reason? }`
    - `POST /api/network/ring/baseline` body `{ subsystemId, ringName, topology, approvedBy }` → `{ ok, reason? }`
    - `POST /api/network/ring/check` body `{ subsystemId, ringName }` → `{ ok, verdict?, reason? }`

- [ ] **Step 1: Add config type**

In `lib/config/types.ts`, add above `AppConfig`:

```typescript
/** Optional SNMP settings for the on-demand ring-commissioning check. Absent or
 *  enabled:false => the feature reads no switches and shows an explanatory state. */
export interface SnmpConfig {
  enabled: boolean
  version: 'v2c' | 'v3'
  community?: string
  port?: number
  timeoutMs?: number
  retries?: number
}
```

and inside `interface AppConfig { ... }` add:

```typescript
  /** Optional — ring-commissioning SNMP reads. Feature self-disables when absent. */
  snmp?: SnmpConfig;
```

- [ ] **Step 2: Write the failing test for target resolution**

```typescript
// __tests__/ring-commissioning-resolve-targets.test.ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { resolveSwitchTargets } from '@/lib/plc/network/ring-commissioning/resolve-targets'

function db() {
  const d = new Database(':memory:')
  d.exec(`CREATE TABLE NetworkRings(id INTEGER PRIMARY KEY, SubsystemId INT, Name TEXT, McmName TEXT, McmIp TEXT, McmTag TEXT);
          CREATE TABLE NetworkNodes(id INTEGER PRIMARY KEY, RingId INT, Name TEXT, Position INT, IpAddress TEXT, StatusTag TEXT, TotalPorts INT);
          CREATE TABLE NetworkPorts(id INTEGER PRIMARY KEY, NodeId INT, PortNumber INT, DeviceName TEXT, DeviceIp TEXT, DeviceType TEXT, StatusTag TEXT, ParentPortId INT);`)
  d.prepare('INSERT INTO NetworkRings VALUES (1,40,?,?,?,?)').run('CDW5 Ring', 'MCM01', '11.0.0.1', 'MCM01_NN')
  d.prepare('INSERT INTO NetworkNodes VALUES (1,1,?,1,?,?,28)').run('UL17_8_DPM1', '11.0.0.10', 'DPM1_NN')
  d.prepare('INSERT INTO NetworkNodes VALUES (2,1,?,2,?,?,28)').run('UL17_8_DPM2', '11.0.0.11', 'DPM2_NN')
  return d
}

describe('resolveSwitchTargets', () => {
  it('builds one ring with its switch IPs from NetworkNodes', () => {
    const rings = resolveSwitchTargets(db(), 40)
    expect(rings.length).toBe(1)
    expect(rings[0].ringName).toBe('CDW5 Ring')
    expect(rings[0].switches.map(s => s.ip).sort()).toEqual(['11.0.0.10', '11.0.0.11'])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run __tests__/ring-commissioning-resolve-targets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `resolve-targets.ts`**

```typescript
// lib/plc/network/ring-commissioning/resolve-targets.ts
import type { Database } from 'better-sqlite3'
import type { SwitchTarget } from './capture'

interface NodeRow { id: number; Name: string; IpAddress: string | null }
interface RingRow { id: number; Name: string }

export interface RingTargets {
  ringName: string
  switches: SwitchTarget[]
  resolveChassis: (chassisId: string) => string
  resolveMac: (mac: string) => string | null
}

/**
 * Build capture targets per ring for a subsystem from NetworkNodes (switches)
 * and NetworkPorts (leaf device IPs/MACs are not stored, so resolveMac maps by
 * DeviceIp only when a later MAC->IP source exists; for now it resolves known
 * device names by a normalized-name fallback and returns null otherwise).
 */
export function resolveSwitchTargets(db: Database, subsystemId: number): RingTargets[] {
  const rings = db.prepare('SELECT id, Name FROM NetworkRings WHERE SubsystemId=?').all(subsystemId) as RingRow[]
  return rings.map((ring) => {
    const nodes = db.prepare('SELECT id, Name, IpAddress FROM NetworkNodes WHERE RingId=?').all(ring.id) as NodeRow[]
    const switches: SwitchTarget[] = nodes
      .filter(n => !!n.IpAddress)
      .map(n => ({ name: n.Name, ip: n.IpAddress as string }))
    // chassis-id (neighbor MAC/name) -> our device name: match by any node whose
    // IP or name embeds the chassis token. Best-effort; refined on hardware.
    const resolveChassis = (chassisId: string): string => {
      const hit = nodes.find(n => chassisId.includes(n.Name) || (n.IpAddress && chassisId.includes(n.IpAddress)))
      return hit ? hit.Name : chassisId
    }
    // We have no MAC inventory yet (Phase 1) — resolveMac returns null so FDB
    // placement is only populated once a MAC source is added. Documented gap.
    const resolveMac = (_mac: string): string | null => null
    return { ringName: ring.Name, switches, resolveChassis, resolveMac }
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/ring-commissioning-resolve-targets.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the three route handlers**

```typescript
// app/api/network/ring/capture/route.ts
import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { resolveSwitchTargets } from '@/lib/plc/network/ring-commissioning/resolve-targets'
import { captureRing } from '@/lib/plc/network/ring-commissioning/capture'
import { readDlrStatus, ringVerdict, deriveDlrPath } from '@/lib/plc/network/dlr'
import type { PortTermination, RingState } from '@/lib/plc/network/ring-commissioning/types'
import type { SnmpCreds } from '@/lib/plc/network/ring-commissioning/snmp/client'

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const snmp = config.snmp
    if (!snmp?.enabled) return res.json({ ok: false, reason: 'SNMP not configured for this tool (config.snmp.enabled=false).' })
    const subsystemId = Number(req.body?.subsystemId ?? config.subsystemId)
    if (!Number.isFinite(subsystemId)) return res.json({ ok: false, reason: 'Subsystem not resolved.' })

    const creds: SnmpCreds = { version: snmp.version, community: snmp.community, port: snmp.port, timeoutMs: snmp.timeoutMs, retries: snmp.retries }
    const rings = resolveSwitchTargets(db, subsystemId)
    if (rings.length === 0) return res.json({ ok: false, reason: 'No ring/switches known for this subsystem — pull network topology first.' })

    // Single ring per capture call (first). DLR ring read (existing) if a supervisor is present.
    const ring = rings[0]
    let dlrRing: RingState | null = null
    const dlrPath = deriveDlrPath(ring.switches.map(s => s.name))
    if (dlrPath && config.plcIp) {
      const dlr = await readDlrStatus(config.plcIp, dlrPath).catch(() => null)
      if (dlr) { const v = ringVerdict(dlr); dlrRing = { closed: v.state === 'healthy', source: 'dlr', reason: v.reason, breakBetween: v.lastActiveNode1 && v.lastActiveNode2 ? [v.lastActiveNode1, v.lastActiveNode2] : undefined } }
    }

    const result = await captureRing(ring.switches, creds, {
      resolveChassis: ring.resolveChassis,
      resolveMac: ring.resolveMac,
      portIfIndex: () => new Map(),
      dlrRing,
      terminations: (): PortTermination[] => [], // 0xF6 terminations wired from poller snapshots in a follow-up; empty is safe
    })
    if (!result.ok) return res.json({ ok: false, reason: result.reason })
    return res.json({ ok: true, ring: { ringName: ring.ringName, topology: result.topology } })
  } catch (e) {
    return res.json({ ok: false, reason: e instanceof Error ? e.message : 'capture failed' })
  }
}
```

```typescript
// app/api/network/ring/baseline/route.ts
import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { saveBaseline, getBaseline } from '@/lib/plc/network/ring-commissioning/baseline-repo'
import type { RingTopology } from '@/lib/plc/network/ring-commissioning/types'

export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const subsystemId = Number(req.query.subsystemId ?? config.subsystemId)
    const ringName = String(req.query.ringName ?? '')
    if (!Number.isFinite(subsystemId) || !ringName) return res.json({ ok: false, reason: 'subsystemId and ringName required' })
    return res.json({ ok: true, baseline: getBaseline(db, subsystemId, ringName) })
  } catch (e) {
    return res.json({ ok: false, reason: e instanceof Error ? e.message : 'read failed' })
  }
}

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const subsystemId = Number(req.body?.subsystemId ?? config.subsystemId)
    const ringName = String(req.body?.ringName ?? '')
    const topology = req.body?.topology as RingTopology | undefined
    const approvedBy = req.body?.approvedBy ? String(req.body.approvedBy) : null
    if (!Number.isFinite(subsystemId) || !ringName || !topology) return res.json({ ok: false, reason: 'subsystemId, ringName, topology required' })
    const now = new Date().toISOString()
    saveBaseline(db, { subsystemId, ringName, capturedAt: now, approvedBy, approvedAt: now, topology })
    return res.json({ ok: true })
  } catch (e) {
    return res.json({ ok: false, reason: e instanceof Error ? e.message : 'save failed' })
  }
}
```

```typescript
// app/api/network/ring/check/route.ts
import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { getBaseline } from '@/lib/plc/network/ring-commissioning/baseline-repo'
import { compareTopology } from '@/lib/plc/network/ring-commissioning/compare'
import { POST as capturePost } from '@/app/api/network/ring/capture/route'

/** Check re-captures actual, then compares to the locked baseline. */
export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const subsystemId = Number(req.body?.subsystemId ?? config.subsystemId)
    const ringName = String(req.body?.ringName ?? '')
    if (!Number.isFinite(subsystemId) || !ringName) return res.json({ ok: false, reason: 'subsystemId and ringName required' })
    const baseline = getBaseline(db, subsystemId, ringName)
    if (!baseline) return res.json({ ok: false, reason: 'No approved baseline for this ring — capture and confirm one first.' })

    // Reuse capture to read actual (captures a fake res to grab its JSON).
    let captured: any = null
    const fakeRes = { json: (b: any) => { captured = b } } as unknown as Response
    await capturePost({ ...req, body: { subsystemId } } as Request, fakeRes)
    if (!captured?.ok) return res.json({ ok: false, reason: captured?.reason ?? 'capture failed' })

    const verdict = compareTopology(baseline.topology, captured.ring.topology)
    return res.json({ ok: true, verdict, ringName })
  } catch (e) {
    return res.json({ ok: false, reason: e instanceof Error ? e.message : 'check failed' })
  }
}
```

- [ ] **Step 7: Mount the routes in `routes/index.ts`**

Add to the import block near line 84–89:

```typescript
import * as ringCapture from '@/app/api/network/ring/capture/route'
import * as ringBaseline from '@/app/api/network/ring/baseline/route'
import * as ringCheck from '@/app/api/network/ring/check/route'
```

Add to the `/api/network` mount block near line 315:

```typescript
  router.post('/api/network/ring/capture', asyncHandler(ringCapture.POST))
  router.get('/api/network/ring/baseline', asyncHandler(ringBaseline.GET))
  router.post('/api/network/ring/baseline', asyncHandler(ringBaseline.POST))
  router.post('/api/network/ring/check', asyncHandler(ringCheck.POST))
```

- [ ] **Step 8: Verify build + all ring tests pass**

Run: `npm run build:server && npx vitest run __tests__/ring-commissioning-*.test.ts`
Expected: server compiles; all ring-commissioning tests PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/config/types.ts lib/plc/network/ring-commissioning/resolve-targets.ts app/api/network/ring routes/index.ts __tests__/ring-commissioning-resolve-targets.test.ts
git commit -m "feat(ring): optional snmp config + on-demand capture/baseline/check routes"
```

---

### Task 8: On-demand UI panel

A self-contained **Ring Commissioning** panel added to the Network page. Buttons: Capture → review (captured topology, editable confirm) → Confirm & Save Baseline; and Check → verdict. When SNMP is unconfigured/unreachable it shows an explanatory empty state, never an error. No shared state with the testing grid.

**Files:**
- Create: `components/ring-commissioning-view.tsx`
- Create: `lib/ring-commissioning/verdict-format.ts` (pure verdict→badge mapping)
- Modify: `components/network-topology-view.tsx` (add a "Ring Commissioning" button in the header that toggles the panel; no change to existing topology rendering)
- Test: `__tests__/ring-commissioning-verdict-format.test.ts`

**Interfaces:**
- Consumes: `RingCommissioningVerdict`, `LinkVerdict` (Task 1 `compare.ts`).
- Produces: `verdict-format.ts`: `function verdictBadge(kind: LinkVerdict['kind']): { label: string; color: 'green'|'red'|'amber'|'gray' }`, `function verdictHeadline(v: RingCommissioningVerdict): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/ring-commissioning-verdict-format.test.ts
import { describe, it, expect } from 'vitest'
import { verdictBadge, verdictHeadline } from '@/lib/ring-commissioning/verdict-format'

describe('verdictBadge', () => {
  it('maps kinds to colors', () => {
    expect(verdictBadge('match').color).toBe('green')
    expect(verdictBadge('wrong-port').color).toBe('red')
    expect(verdictBadge('missing').color).toBe('red')
    expect(verdictBadge('unexpected').color).toBe('amber')
  })
})
describe('verdictHeadline', () => {
  it('summarises healthy vs faults', () => {
    expect(verdictHeadline({ healthy: true, ringClosed: true, ringReason: 'ok', links: [], leafVerdicts: [], terminationFaults: [] }))
      .toMatch(/healthy/i)
    expect(verdictHeadline({ healthy: false, ringClosed: false, ringReason: 'Ring Fault', links: [], leafVerdicts: [], terminationFaults: [] }))
      .toMatch(/ring open|fault/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/ring-commissioning-verdict-format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `verdict-format.ts`**

```typescript
// lib/ring-commissioning/verdict-format.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/ring-commissioning-verdict-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the panel component**

```tsx
// components/ring-commissioning-view.tsx
"use client"
import { useState } from 'react'
import { authFetch } from '@/lib/api-config'
import { verdictBadge, verdictHeadline } from '@/lib/ring-commissioning/verdict-format'
import type { RingCommissioningVerdict } from '@/lib/plc/network/ring-commissioning/compare'

interface Props { subsystemId?: number }
type Phase = 'idle' | 'capturing' | 'review' | 'checking'

export function RingCommissioningView({ subsystemId }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [captured, setCaptured] = useState<{ ringName: string; topology: any } | null>(null)
  const [verdict, setVerdict] = useState<RingCommissioningVerdict | null>(null)
  const [approvedBy, setApprovedBy] = useState('')

  const body = subsystemId ? { subsystemId } : {}

  async function capture() {
    setPhase('capturing'); setMessage(null); setVerdict(null)
    try {
      const r = await authFetch('/api/network/ring/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json()
      if (!d.ok) { setMessage(d.reason); setPhase('idle'); return }
      setCaptured(d.ring); setPhase('review')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'capture failed'); setPhase('idle') }
  }

  async function saveBaseline() {
    if (!captured) return
    try {
      const r = await authFetch('/api/network/ring/baseline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ringName: captured.ringName, topology: captured.topology, approvedBy }) })
      const d = await r.json()
      setMessage(d.ok ? 'Baseline approved and locked.' : d.reason)
      if (d.ok) setPhase('idle')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'save failed') }
  }

  async function check() {
    if (!captured?.ringName) { setMessage('Capture a ring first (need its name).'); return }
    setPhase('checking'); setMessage(null)
    try {
      const r = await authFetch('/api/network/ring/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ringName: captured.ringName }) })
      const d = await r.json()
      if (!d.ok) { setMessage(d.reason); setPhase('idle'); return }
      setVerdict(d.verdict); setPhase('idle')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'check failed'); setPhase('idle') }
  }

  return (
    <div className="border rounded-lg p-4 bg-card space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-sm">Ring Commissioning</h3>
        <span className="text-[10px] text-muted-foreground">on-demand · read-only · field-unverified</span>
      </div>
      <div className="flex gap-2">
        <button onClick={capture} disabled={phase === 'capturing'} className="px-3 py-1.5 text-sm rounded-md border bg-card hover:bg-accent disabled:opacity-50">
          {phase === 'capturing' ? 'Capturing…' : 'Capture Ring Topology'}
        </button>
        <button onClick={check} disabled={phase === 'checking'} className="px-3 py-1.5 text-sm rounded-md border bg-card hover:bg-accent disabled:opacity-50">
          {phase === 'checking' ? 'Checking…' : 'Check Ring'}
        </button>
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      {phase === 'review' && captured && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm">Captured <span className="font-mono">{captured.ringName}</span>: {captured.topology.links.length} switch links, {captured.topology.leaves.length} leaf placements, ring {captured.topology.ring.closed ? 'closed' : 'open'}.</p>
          <p className="text-xs text-amber-600">Confirm this matches the drawing before saving — this becomes the approved baseline.</p>
          <div className="flex items-center gap-2">
            <input value={approvedBy} onChange={e => setApprovedBy(e.target.value)} placeholder="Your name" className="px-2 py-1 text-sm rounded border bg-background" />
            <button onClick={saveBaseline} className="px-3 py-1.5 text-sm rounded-md border bg-primary/10 text-primary hover:bg-primary/20">Confirm &amp; Save Baseline</button>
          </div>
        </div>
      )}

      {verdict && (
        <div className="space-y-2 border-t pt-3">
          <p className={`text-sm font-medium ${verdict.healthy ? 'text-emerald-600' : 'text-red-600'}`}>{verdictHeadline(verdict)}</p>
          {[...verdict.links, ...verdict.leafVerdicts, ...verdict.terminationFaults].filter(l => l.kind !== 'match').map((l, i) => {
            const b = verdictBadge(l.kind)
            return <div key={i} className="text-xs flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded ${b.color === 'red' ? 'bg-red-500/10 text-red-600' : b.color === 'amber' ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground'}`}>{b.label}</span>
              <span className="text-muted-foreground">{l.detail}</span>
            </div>
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Wire the panel into the Network page header**

In `components/network-topology-view.tsx`, add near the top imports:

```typescript
import { RingCommissioningView } from '@/components/ring-commissioning-view'
```

Add a toggle state inside `NetworkTopologyView` (near the other `useState`s ~line 873):

```typescript
  const [showRingCommissioning, setShowRingCommissioning] = useState(false)
```

Add a button in the header actions block (next to the Diagnostics button ~line 1138):

```tsx
          <button
            type="button"
            onClick={() => setShowRingCommissioning(v => !v)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border bg-card hover:bg-accent transition-colors"
          >
            Ring Commissioning
          </button>
```

Render the panel just under the header block (after the closing `</div>` of the header flex, ~line 1150):

```tsx
      {showRingCommissioning && <RingCommissioningView subsystemId={subsystemId} />}
```

- [ ] **Step 7: Verify build + client typecheck + tests**

Run: `npm run build && npx vitest run __tests__/ring-commissioning-verdict-format.test.ts`
Expected: client builds; test PASS.

- [ ] **Step 8: Commit**

```bash
git add components/ring-commissioning-view.tsx components/network-topology-view.tsx lib/ring-commissioning/verdict-format.ts __tests__/ring-commissioning-verdict-format.test.ts
git commit -m "feat(ring): on-demand Ring Commissioning panel on the Network page"
```

---

### Task 9: Full-suite regression + isolation check

Confirm the feature changed nothing else and the whole tool still builds and tests green.

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run`
Expected: all pre-existing tests still PASS; the 6 new ring-commissioning test files PASS.

- [ ] **Step 2: Build server + client**

Run: `npm run build:server && npm run build`
Expected: both succeed.

- [ ] **Step 3: Lint the new files**

Run: `npm run lint`
Expected: no new errors in `lib/plc/network/ring-commissioning/**`, `components/ring-commissioning-view.tsx`, `app/api/network/ring/**`.

- [ ] **Step 4: Manual smoke (SNMP off = safe default)**

Run: `npm run dev`, open the Network page, click **Ring Commissioning** → **Capture**.
Expected: with no `config.snmp`, the panel shows "SNMP not configured…" and nothing in the rest of the tool is affected (grid, sync, PLC unaffected). No console errors, no lag.

- [ ] **Step 5: Commit any lint fixes**

```bash
git add -A && git commit -m "chore(ring): lint + regression pass (feature isolated, SNMP-off safe)"
```

---

### Task 10: How-it-works PDF deliverable

Produce the operator/reviewer document.

**Files:**
- Create: `frontend/specs/ring-commissioning-explained.md` (source)
- Create: PDF export (via the repo's existing markdown→PDF path, or an HTML print export if none exists)

- [ ] **Step 1: Write `ring-commissioning-explained.md`**

Cover, in plain language: what the check proves (right switch↔switch, right ports, ring closed, clean terminations); how it reads from one point (DLR + LLDP + FDB + CIP 0xF6); the capture → confirm-against-print → lock flow and why the human confirm step is what makes it authoritative (the MTN6 lesson); what each source contributes (table); setup (`config.snmp`); on-demand + read-only + isolated guarantees; and the honest **field-unverified** limitation (bench is an Emulate 5580; Moxa Turbo Ring OID pending hardware). Reuse wording from `ring-health-explained.md` for consistency.

- [ ] **Step 2: Export to PDF**

Use the existing doc→PDF mechanism if the repo has one (check `deploy/` / scripts); otherwise open the markdown as HTML and Print → Save as PDF. Save as `Ring-Commissioning-Explained.pdf`.

- [ ] **Step 3: Commit the source doc**

```bash
git add frontend/specs/ring-commissioning-explained.md
git commit -m "docs(ring): how-it-works explainer for ring-commissioning (PDF source)"
```

---

## Self-Review Notes

- **Spec coverage:** capture→confirm→lock (Tasks 5–8), SNMP LLDP+FDB (Tasks 2–4), vendor adapters incl. Moxa/Hirschmann (Task 4), DLR reuse (Task 7 route), termination health via 0xF6 (compare Task 1; wired empty-safe in Task 7 with a documented follow-up), additive DB/config/routes (Tasks 6–7), on-demand UI (Task 8), isolation/fail-safe (Global Constraints + Task 9), PDF (Task 10). All covered.
- **Known documented gaps (intentional, safe):** (a) FDB leaf resolution returns null until a MAC inventory exists (`resolveMac` in Task 7) — links/uplinks still verify; (b) `0xF6` terminations are wired as empty in the capture route with a follow-up note — compare handles empty safely; (c) Moxa Turbo Ring OID is a placeholder that never false-greens. These match the spec's "field-unverified until hardware" posture.
- **Type consistency:** `RingTopology`/`SwitchLink`/`LeafPlacement`/`PortTermination`/`RingState`/`RingBaseline` defined once in Task 1 and imported everywhere; `compareTopology`, `captureRing`/`assembleTopology`, `saveBaseline`/`getBaseline`, `snmpWalk`, `selectVendor`/`decodeRingState`, `parseLldpNeighbors`/`parseFdb`, `verdictBadge`/`verdictHeadline` names used consistently across tasks.
