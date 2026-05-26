import { describe, it, expect } from 'vitest'
import { parseLldpNeighbors, decodeOctet } from '@/lib/network/ring/lldp'
import { parsePortStats } from '@/lib/network/ring/if-mib'
import { interpretRingStatus, interpretModbusRing } from '@/lib/network/ring/ring-status'
import { buildReport, buildBaselineFromScan } from '@/lib/network/ring/compare'
import { LLDP_REM, IF_MIB, ETHERLIKE } from '@/lib/network/ring/oids'
import type { RingScanResult, RingPortStat, LldpNeighbor, DpmScan } from '@/lib/network/ring/types'

// ── LLDP parser ────────────────────────────────────────────────────────────

describe('parseLldpNeighbors', () => {
  it('groups columns by (localPort, remIndex) and extracts the local port from the row index', () => {
    // Row index = timeMark.localPort.remIndex = 0.3.1
    const vbs = [
      { oid: `${LLDP_REM.SYS_NAME}.0.3.1`, value: 'NCP1_2_DPM1' },
      { oid: `${LLDP_REM.CHASSIS_ID}.0.3.1`, value: Buffer.from([0xaa, 0xbb, 0xcc, 0x00, 0x00, 0x02]) },
      { oid: `${LLDP_REM.PORT_ID}.0.3.1`, value: 'port-2' },
      // A second neighbor on a different local port
      { oid: `${LLDP_REM.SYS_NAME}.0.4.1`, value: 'NCP1_3_DPM1' },
    ]
    const ns = parseLldpNeighbors(vbs)
    expect(ns).toHaveLength(2)
    const p3 = ns.find((n) => n.localPort === 3)!
    expect(p3.remoteSysName).toBe('NCP1_2_DPM1')
    expect(p3.remoteChassisId).toBe('aa:bb:cc:00:00:02')
    expect(p3.remotePortId).toBe('port-2')
    expect(ns.find((n) => n.localPort === 4)!.remoteSysName).toBe('NCP1_3_DPM1')
  })

  it('decodeOctet renders MAC bytes as colon-hex and printable bytes as text', () => {
    expect(decodeOctet(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))).toBe('00:01:02:03:04:05')
    expect(decodeOctet(Buffer.from('SWITCH01', 'utf8'))).toBe('SWITCH01')
    expect(decodeOctet('  trimmed  ')).toBe('trimmed')
    expect(decodeOctet(null)).toBe('')
  })
})

// ── IF-MIB parser ────────────────────────────────────────────────────────────

describe('parsePortStats', () => {
  it('assembles per-ifIndex stats and prefers ifHighSpeed over ifSpeed', () => {
    const vbs = [
      { oid: `${IF_MIB.OPER_STATUS}.1`, value: 1 },
      { oid: `${IF_MIB.SPEED}.1`, value: 1_000_000_000 }, // 1000 Mbps in bits/s
      { oid: `${IF_MIB.HIGH_SPEED}.1`, value: 1000 },
      { oid: `${IF_MIB.IN_ERRORS}.1`, value: 0 },
      { oid: `${IF_MIB.OUT_ERRORS}.1`, value: 0 },
      { oid: `${ETHERLIKE.FCS_ERRORS}.1`, value: 4 },
      { oid: `${ETHERLIKE.ALIGNMENT_ERRORS}.1`, value: 1 },
      { oid: `${ETHERLIKE.DUPLEX_STATUS}.1`, value: 3 },
      // port 2 down, half duplex, 100M via ifSpeed only
      { oid: `${IF_MIB.OPER_STATUS}.2`, value: 2 },
      { oid: `${IF_MIB.SPEED}.2`, value: 100_000_000 },
      { oid: `${ETHERLIKE.DUPLEX_STATUS}.2`, value: 2 },
    ]
    const ports = parsePortStats(vbs)
    expect(ports).toHaveLength(2)
    const p1 = ports[0]
    expect(p1).toMatchObject({ port: 1, linkUp: true, speedMbps: 1000, fullDuplex: true, fcsErrors: 4, alignmentErrors: 1 })
    const p2 = ports[1]
    expect(p2).toMatchObject({ port: 2, linkUp: false, speedMbps: 100, fullDuplex: false })
  })
})

// ── Ring status interpreter ──────────────────────────────────────────────────

describe('interpretRingStatus', () => {
  it('maps Turbo Ring V2 healthy master', () => {
    expect(interpretRingStatus({ protocol: 3, ringStatus: 0, masterSlave: 1 })).toEqual({
      protocol: 'Turbo Ring V2', health: 'healthy', role: 'master',
    })
  })
  it('maps a ring break', () => {
    expect(interpretRingStatus({ protocol: 3, ringStatus: 1, masterSlave: 0 })).toMatchObject({ health: 'broken', role: 'slave' })
  })
  it('treats protocol None as not-enabled', () => {
    expect(interpretRingStatus({ protocol: 0 })).toEqual({ protocol: 'None', health: 'not-enabled', role: 'not-enabled' })
  })
  it('unknown when ring code missing', () => {
    expect(interpretRingStatus({ protocol: 3 }).health).toBe('unknown')
  })
})

describe('interpretModbusRing (Modbus fallback registers)', () => {
  it('maps Turbo Ring V2 healthy master from registers', () => {
    expect(interpretModbusRing({ protocol: 3, v2Status: 0, v2Master: 1 })).toEqual({
      protocol: 'Turbo Ring V2', health: 'healthy', role: 'master',
    })
  })
  it('maps a V2 ring break', () => {
    expect(interpretModbusRing({ protocol: 3, v2Status: 1, v2Master: 0 })).toMatchObject({ health: 'broken' })
  })
  it('treats 0xFFFF as not-enabled/absent and falls back to v1 master register', () => {
    const r = interpretModbusRing({ protocol: 2, v2Status: 0xffff, v2Master: 0xffff, v1Master: 1 })
    expect(r.protocol).toBe('Turbo Ring')
    expect(r.health).toBe('unknown') // v1 has no single healthy/break register here
    expect(r.role).toBe('master')
  })
  it('all 0xFFFF → unknown protocol/health', () => {
    expect(interpretModbusRing({ protocol: 0xffff, v2Status: 0xffff }).health).toBe('unknown')
  })
})

// ── Comparison engine ────────────────────────────────────────────────────────

const CH = { A: 'aa:00:00:00:00:01', B: 'aa:00:00:00:00:02', C: 'aa:00:00:00:00:03' }

function port(p: number, over: Partial<RingPortStat> = {}): RingPortStat {
  return { port: p, linkUp: true, speedMbps: 1000, fullDuplex: true, inErrors: 0, outErrors: 0, fcsErrors: 0, alignmentErrors: 0, ...over }
}
function neigh(localPort: number, chassis: string): LldpNeighbor {
  return { localPort, remoteChassisId: chassis, remotePortId: 'x' }
}
function dpm(name: string, chassis: string, neighbors: LldpNeighbor[]): DpmScan {
  return {
    dpmName: name, ip: `11.200.1.${chassis.slice(-1)}`, reachable: true, sysName: name,
    localChassisId: chassis, neighbors, ports: [port(1), port(2), port(5)],
    ring: { protocol: 'Turbo Ring V2', health: 'healthy', role: name === 'A' ? 'master' : 'slave' },
    scannedAt: 1000,
  }
}

// Canonical clean ring: A:1↔B:2, B:1↔C:2, C:1↔A:2
function makeScan(): RingScanResult {
  return {
    ringId: 1, ringName: 'Test Ring', scannedAt: 1000,
    dpms: [
      dpm('A', CH.A, [neigh(1, CH.B), neigh(2, CH.C)]),
      dpm('B', CH.B, [neigh(2, CH.A), neigh(1, CH.C)]),
      dpm('C', CH.C, [neigh(2, CH.B), neigh(1, CH.A)]),
    ],
  }
}

function linkFor(report: ReturnType<typeof buildReport>, dpmName: string, localPort: number) {
  return report.dpms.find((d) => d.dpmName === dpmName)!.links.find((l) => l.localPort === localPort)!
}

describe('buildBaselineFromScan', () => {
  it('captures observed links with reciprocal remote ports and a chassis→DPM map', () => {
    const baseline = buildBaselineFromScan(makeScan(), 'tech1')
    expect(baseline.links).toHaveLength(6) // 2 ring uplinks × 3 DPMs
    expect(baseline.chassisToDpm).toEqual({ [CH.A]: 'A', [CH.B]: 'B', [CH.C]: 'C' })
    const aPort1 = baseline.links.find((l) => l.localDpm === 'A' && l.localPort === 1)!
    expect(aPort1).toMatchObject({ remoteDpm: 'B', remotePort: 2, expectedSpeedMbps: 1000 })
    expect(baseline.savedBy).toBe('tech1')
  })
})

describe('buildReport', () => {
  it('clean ring passes everything', () => {
    const baseline = buildBaselineFromScan(makeScan())
    const report = buildReport(makeScan(), baseline)
    expect(report.overall).toBe('pass')
    expect(report.summary.fail).toBe(0)
    expect(report.reachability.state).toBe('pass')
    expect(linkFor(report, 'A', 1).state).toBe('pass')
  })

  it('catches the MTN6 wrong-port miswire (ring still forms)', () => {
    const baseline = buildBaselineFromScan(makeScan())
    const scan = makeScan()
    // A's port-1 cable now lands on B's port 3 instead of port 2.
    const b = scan.dpms.find((d) => d.dpmName === 'B')!
    b.neighbors = [neigh(3, CH.A), neigh(1, CH.C)]
    const report = buildReport(scan, baseline)

    const aLink = linkFor(report, 'A', 1)
    expect(aLink.state).toBe('fail')
    expect(aLink.message).toContain('WRONG PORT')
    expect(aLink.actualRemotePort).toBe(3)
    expect(aLink.expectedRemotePort).toBe(2)
    expect(report.overall).toBe('fail')
  })

  it('catches a wrong-neighbor miswire', () => {
    const baseline = buildBaselineFromScan(makeScan())
    const scan = makeScan()
    const a = scan.dpms.find((d) => d.dpmName === 'A')!
    a.neighbors = [neigh(1, CH.C), neigh(2, CH.C)] // port 1 now goes to C, not B
    const report = buildReport(scan, baseline)
    const aLink = linkFor(report, 'A', 1)
    expect(aLink.state).toBe('fail')
    expect(aLink.actualRemoteDpm).toBe('C')
    expect(aLink.message).toContain('drawing says B')
  })

  it('flags a missing/unplugged ring link', () => {
    const baseline = buildBaselineFromScan(makeScan())
    const scan = makeScan()
    const a = scan.dpms.find((d) => d.dpmName === 'A')!
    a.neighbors = [neigh(2, CH.C)] // port-1 uplink gone
    const report = buildReport(scan, baseline)
    const aLink = linkFor(report, 'A', 1)
    expect(aLink.state).toBe('fail')
    expect(aLink.message).toContain('no ring neighbor detected')
  })

  it('fails on a broken ring', () => {
    const baseline = buildBaselineFromScan(makeScan())
    const scan = makeScan()
    scan.dpms.find((d) => d.dpmName === 'A')!.ring.health = 'broken'
    const report = buildReport(scan, baseline)
    expect(report.dpms.find((d) => d.dpmName === 'A')!.ringHealth.state).toBe('fail')
    expect(report.overall).toBe('fail')
  })

  it('fails termination on a speed mismatch (bad termination negotiated down)', () => {
    const baseline = buildBaselineFromScan(makeScan())
    const scan = makeScan()
    const a = scan.dpms.find((d) => d.dpmName === 'A')!
    a.ports = [port(1, { speedMbps: 100 }), port(2), port(5)]
    const report = buildReport(scan, baseline)
    const term = report.dpms.find((d) => d.dpmName === 'A')!.terminations.find((t) => t.port === 1)!
    expect(term.state).toBe('fail')
    expect(term.message).toContain('expected 1000 Mbps')
  })

  it('warns on error counters present on a ring port', () => {
    const baseline = buildBaselineFromScan(makeScan())
    const scan = makeScan()
    const a = scan.dpms.find((d) => d.dpmName === 'A')!
    a.ports = [port(1, { fcsErrors: 5 }), port(2), port(5)]
    const report = buildReport(scan, baseline)
    const term = report.dpms.find((d) => d.dpmName === 'A')!.terminations.find((t) => t.port === 1)!
    expect(term.state).toBe('warn')
    expect(term.message).toContain('error')
  })

  it('reports an unreachable switch without failing the scan structure', () => {
    const baseline = buildBaselineFromScan(makeScan())
    const scan = makeScan()
    const b = scan.dpms.find((d) => d.dpmName === 'B')!
    b.reachable = false
    const report = buildReport(scan, baseline)
    expect(report.reachability.state).toBe('fail')
    expect(report.reachability.message).toContain('B')
    expect(report.dpms.find((d) => d.dpmName === 'B')!.ringHealth.state).toBe('skip')
    expect(report.overall).toBe('fail')
  })

  it('first run with no baseline surfaces observed topology for review (skip, not fail)', () => {
    const report = buildReport(makeScan(), null)
    expect(report.hasBaseline).toBe(false)
    expect(linkFor(report, 'A', 1).state).toBe('skip')
    expect(linkFor(report, 'A', 1).message).toContain('Review against the drawing')
    // Ring health + terminations still evaluated, so a clean ring with no baseline passes.
    expect(report.overall).toBe('pass')
    expect(report.summary.skip).toBeGreaterThan(0)
  })
})
