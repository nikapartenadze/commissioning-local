/**
 * Ring commissioning comparison engine.
 *
 * Given a live scan and (optionally) a saved baseline, produce the pass/fail
 * commissioning report: reachability, ring health, topology vs baseline
 * (including the exact-remote-port check that catches the MTN6 miswire), and
 * per-ring-port termination quality.
 *
 * Pure: no SNMP, no DB. Fully unit-tested.
 */

import type {
  RingScanResult,
  RingBaseline,
  RingCheckReport,
  DpmReport,
  LinkCheck,
  PortTerminationCheck,
  CheckState,
  LldpNeighbor,
  DpmScan,
} from './types';

/** An observed inter-DPM ring link, from one DPM's point of view. */
interface ActualLink {
  localPort: number;
  remoteDpm: string;
  /** Remote port number, resolved via the reciprocal LLDP entry; undefined if one-way. */
  remotePort?: number;
}

/** Resolve which DPM (by name) an LLDP neighbor corresponds to, or undefined. */
export function resolveNeighborDpm(
  n: LldpNeighbor,
  scan: RingScanResult,
  baseline: RingBaseline | null,
): string | undefined {
  // 1. Most robust: neighbor's chassis id == some switch's own LLDP chassis id.
  if (n.remoteChassisId) {
    const byChassis = scan.dpms.find(
      (d) => d.localChassisId && d.localChassisId === n.remoteChassisId,
    );
    if (byChassis) return byChassis.dpmName;
  }
  // 2. Neighbor sysName == a scanned switch's sysName.
  if (n.remoteSysName) {
    const bySys = scan.dpms.find((d) => d.sysName && d.sysName === n.remoteSysName);
    if (bySys) return bySys.dpmName;
    // 3. Neighbor sysName == a DPM name directly.
    const byName = scan.dpms.find((d) => d.dpmName === n.remoteSysName);
    if (byName) return byName.dpmName;
  }
  // 4. Saved chassis→DPM map (covers a switch that has since lost its sysName).
  if (baseline && n.remoteChassisId && baseline.chassisToDpm[n.remoteChassisId]) {
    return baseline.chassisToDpm[n.remoteChassisId];
  }
  return undefined;
}

/** Find the port on `remoteDpm` that sees `localDpm` — the reciprocal link's local port. */
function reciprocalPort(
  remoteDpm: string,
  localDpm: string,
  scan: RingScanResult,
  baseline: RingBaseline | null,
): number | undefined {
  const remote = scan.dpms.find((d) => d.dpmName === remoteDpm);
  if (!remote) return undefined;
  const back = remote.neighbors.find((n) => resolveNeighborDpm(n, scan, baseline) === localDpm);
  return back?.localPort;
}

/** Build the observed inter-DPM ring links for one DPM. */
function actualLinksFor(
  dpm: DpmScan,
  scan: RingScanResult,
  baseline: RingBaseline | null,
): ActualLink[] {
  const links: ActualLink[] = [];
  for (const n of dpm.neighbors) {
    const remoteDpm = resolveNeighborDpm(n, scan, baseline);
    if (!remoteDpm || remoteDpm === dpm.dpmName) continue; // not a ring peer
    links.push({
      localPort: n.localPort,
      remoteDpm,
      remotePort: reciprocalPort(remoteDpm, dpm.dpmName, scan, baseline),
    });
  }
  return links.sort((a, b) => a.localPort - b.localPort);
}

/** Worst state across a set (fail > warn > pass; skip is neutral). */
function worst(states: CheckState[]): CheckState {
  if (states.includes('fail')) return 'fail';
  if (states.includes('warn')) return 'warn';
  if (states.includes('pass')) return 'pass';
  return 'skip';
}

/**
 * Build a baseline (the "expected" wiring) from a scan the tech has confirmed
 * against the drawing. Captures observed links + a chassis→DPM identity map +
 * the speed/duplex seen at save time as the expected values.
 */
export function buildBaselineFromScan(scan: RingScanResult, savedBy?: string): RingBaseline {
  const chassisToDpm: Record<string, string> = {};
  for (const d of scan.dpms) {
    if (d.localChassisId) chassisToDpm[d.localChassisId] = d.dpmName;
  }
  const links = scan.dpms.flatMap((d) =>
    actualLinksFor(d, scan, null).map((a) => {
      const stat = d.ports.find((p) => p.port === a.localPort);
      return {
        localDpm: d.dpmName,
        localPort: a.localPort,
        remoteDpm: a.remoteDpm,
        remotePort: a.remotePort ?? 0,
        expectedSpeedMbps: stat && stat.speedMbps > 0 ? stat.speedMbps : undefined,
        expectedFullDuplex: stat?.fullDuplex ?? undefined,
      };
    }),
  );
  return { ringId: scan.ringId, links, chassisToDpm, savedAt: Date.now(), savedBy };
}

/** Compare a scan against an optional baseline and produce the report. */
export function buildReport(scan: RingScanResult, baseline: RingBaseline | null): RingCheckReport {
  const hasBaseline = !!baseline && baseline.links.length > 0;
  const allStates: CheckState[] = [];

  // Reachability.
  const unreachable = scan.dpms.filter((d) => !d.reachable);
  const reachability =
    unreachable.length === 0
      ? { state: 'pass' as CheckState, message: `All ${scan.dpms.length} switch(es) responded.` }
      : {
          state: 'fail' as CheckState,
          message: `Unreachable: ${unreachable.map((d) => `${d.dpmName} (${d.ip})`).join(', ')}`,
        };
  allStates.push(reachability.state);

  const dpms: DpmReport[] = scan.dpms.map((dpm) => {
    if (!dpm.reachable) {
      const ringHealth = { state: 'skip' as CheckState, message: 'Switch unreachable — not checked.' };
      allStates.push(ringHealth.state);
      return { dpmName: dpm.dpmName, ip: dpm.ip, reachable: false, ringHealth, links: [], terminations: [] };
    }

    // Ring health.
    const ringHealth = ringHealthCheck(dpm);
    allStates.push(ringHealth.state);

    // Topology.
    const actual = actualLinksFor(dpm, scan, baseline);
    const links: LinkCheck[] = [];

    if (hasBaseline) {
      const expectedLinks = baseline!.links.filter((l) => l.localDpm === dpm.dpmName);
      const matchedPorts = new Set<number>();

      for (const exp of expectedLinks) {
        const act = actual.find((a) => a.localPort === exp.localPort);
        let state: CheckState;
        let message: string;
        if (!act) {
          state = 'fail';
          message = `Expected uplink on port ${exp.localPort} → ${exp.remoteDpm} port ${exp.remotePort}, but no ring neighbor detected (cable unplugged, in the wrong port, or switch down).`;
        } else {
          matchedPorts.add(act.localPort);
          if (act.remoteDpm !== exp.remoteDpm) {
            state = 'fail';
            message = `Port ${exp.localPort} connects to ${act.remoteDpm} — drawing says ${exp.remoteDpm}.`;
          } else if (act.remotePort != null && act.remotePort !== exp.remotePort) {
            state = 'fail';
            message = `WRONG PORT: port ${exp.localPort} reaches ${exp.remoteDpm} port ${act.remotePort}, but the drawing says port ${exp.remotePort}.`;
          } else {
            state = 'pass';
            message = `Port ${exp.localPort} → ${exp.remoteDpm} port ${exp.remotePort}.`;
          }
        }
        links.push({
          localDpm: dpm.dpmName,
          localPort: exp.localPort,
          expectedRemoteDpm: exp.remoteDpm,
          expectedRemotePort: exp.remotePort,
          actualRemoteDpm: act?.remoteDpm,
          actualRemotePort: act?.remotePort,
          state,
          message,
        });
      }

      // Unexpected ring uplinks not described by the baseline.
      for (const act of actual) {
        if (matchedPorts.has(act.localPort)) continue;
        links.push({
          localDpm: dpm.dpmName,
          localPort: act.localPort,
          actualRemoteDpm: act.remoteDpm,
          actualRemotePort: act.remotePort,
          state: 'warn',
          message: `Unexpected ring uplink on port ${act.localPort} → ${act.remoteDpm} port ${act.remotePort ?? '?'} (not in baseline).`,
        });
      }
    } else {
      // No baseline yet — surface observed topology for review.
      for (const act of actual) {
        links.push({
          localDpm: dpm.dpmName,
          localPort: act.localPort,
          actualRemoteDpm: act.remoteDpm,
          actualRemotePort: act.remotePort,
          state: 'skip',
          message: `Observed: port ${act.localPort} → ${act.remoteDpm} port ${act.remotePort ?? '?'}. Review against the drawing, then Save as baseline.`,
        });
      }
    }
    links.forEach((l) => allStates.push(l.state));

    // Termination quality on ring ports.
    const ringPorts = new Set<number>();
    actual.forEach((a) => ringPorts.add(a.localPort));
    if (hasBaseline) baseline!.links.filter((l) => l.localDpm === dpm.dpmName).forEach((l) => ringPorts.add(l.localPort));

    const terminations: PortTerminationCheck[] = [...ringPorts]
      .sort((a, b) => a - b)
      .map((port) => {
        const stat = dpm.ports.find((p) => p.port === port);
        const expected = hasBaseline
          ? baseline!.links.find((l) => l.localDpm === dpm.dpmName && l.localPort === port)?.expectedSpeedMbps
          : undefined;
        return terminationCheck(dpm.dpmName, port, stat, expected);
      });
    terminations.forEach((t) => allStates.push(t.state));

    return { dpmName: dpm.dpmName, ip: dpm.ip, reachable: true, ringHealth, links, terminations };
  });

  const summary = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const s of allStates) summary[s]++;

  return {
    ringId: scan.ringId,
    ringName: scan.ringName,
    generatedAt: scan.scannedAt,
    hasBaseline,
    overall: worst(allStates),
    reachability,
    dpms,
    summary,
  };
}

function ringHealthCheck(dpm: DpmScan): { state: CheckState; message: string } {
  const { protocol, health, role } = dpm.ring;
  switch (health) {
    case 'healthy':
      return { state: 'pass', message: `${protocol} ring healthy (${role}).` };
    case 'broken':
      return { state: 'fail', message: `${protocol} ring is BROKEN — running on the redundant path or a segment is down (${role}).` };
    case 'not-enabled':
      return { state: 'warn', message: `No ring redundancy enabled on this switch (protocol: ${protocol}).` };
    default:
      return { state: 'warn', message: `Ring status could not be read (protocol: ${protocol}). Confirm the Moxa MIB OID or enable the Modbus fallback.` };
  }
}

function terminationCheck(
  dpm: string,
  port: number,
  stat: { linkUp: boolean; speedMbps: number; fullDuplex: boolean | null; inErrors: number; outErrors: number; fcsErrors: number; alignmentErrors: number } | undefined,
  expectedSpeedMbps: number | undefined,
): PortTerminationCheck {
  if (!stat) {
    return {
      dpm, port, linkUp: false, speedMbps: 0, expectedSpeedMbps, fullDuplex: null, errorsTotal: 0,
      state: 'warn', message: `Port ${port}: no interface stats returned.`,
    };
  }
  const errorsTotal = stat.inErrors + stat.outErrors + stat.fcsErrors + stat.alignmentErrors;
  const base = { dpm, port, linkUp: stat.linkUp, speedMbps: stat.speedMbps, expectedSpeedMbps, fullDuplex: stat.fullDuplex, errorsTotal };

  if (!stat.linkUp) {
    return { ...base, state: 'fail', message: `Ring port ${port} is DOWN.` };
  }
  if (expectedSpeedMbps != null && stat.speedMbps > 0 && stat.speedMbps !== expectedSpeedMbps) {
    return { ...base, state: 'fail', message: `Port ${port} negotiated ${stat.speedMbps} Mbps, expected ${expectedSpeedMbps} Mbps — check cable/termination.` };
  }
  if (stat.fullDuplex === false) {
    return { ...base, state: 'warn', message: `Port ${port} is half-duplex — likely a duplex/termination problem.` };
  }
  if (errorsTotal > 0) {
    return { ...base, state: 'warn', message: `Port ${port} has ${errorsTotal} error(s) (FCS/alignment/in/out) — possible marginal termination.` };
  }
  return { ...base, state: 'pass', message: `Port ${port} up @ ${stat.speedMbps} Mbps, clean.` };
}
