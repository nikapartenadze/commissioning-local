/**
 * LLDP-MIB parsing.
 *
 * Turns walked varbinds from the four lldpRemTable columns into a list of
 * neighbors keyed by local port. Pure — no SNMP transport here.
 *
 * lldpRemTable row index is `lldpRemTimeMark.lldpRemLocalPortNum.lldpRemIndex`,
 * so the suffix after each column OID has exactly three segments; the middle
 * one is the local port number.
 */

import type { Varbind, LldpNeighbor } from './types';
import { LLDP_REM } from './oids';

/**
 * Render an SNMP OCTET STRING value as a stable string. Printable ASCII →
 * trimmed UTF-8; anything with non-printable bytes (e.g. a MAC chassis id) →
 * lowercase colon-hex. Numbers/strings pass through.
 */
export function decodeOctet(value: string | number | Buffer | null): string {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim();
  // Buffer
  const printable = value.length > 0 && value.every((b) => b >= 0x20 && b <= 0x7e);
  if (printable) return value.toString('utf8').trim();
  return Array.from(value)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

/** Extract the column base an OID belongs to, or null. */
function columnOf(oid: string): keyof typeof LLDP_REM | null {
  for (const [name, base] of Object.entries(LLDP_REM)) {
    if (oid === base || oid.startsWith(base + '.')) return name as keyof typeof LLDP_REM;
  }
  return null;
}

/** Parse the local port number out of an lldpRemTable row suffix. */
function localPortFromSuffix(suffix: string): number | null {
  const parts = suffix.split('.').filter((p) => p.length > 0);
  // [timeMark, localPortNum, remIndex]
  if (parts.length < 3) return null;
  const port = Number(parts[1]);
  return Number.isFinite(port) ? port : null;
}

/**
 * Parse neighbors from a flat list of varbinds gathered across the LLDP remote
 * columns (chassis id, port id, port desc, sys name). One neighbor per
 * (localPort, remIndex) row.
 */
export function parseLldpNeighbors(varbinds: Varbind[]): LldpNeighbor[] {
  // rowKey = `${localPort}.${remIndex}`
  const rows = new Map<string, LldpNeighbor & { _remIndex: string }>();

  for (const vb of varbinds) {
    const col = columnOf(vb.oid);
    if (!col) continue;
    const base = LLDP_REM[col];
    const suffix = vb.oid.slice(base.length + 1); // drop "base."
    const localPort = localPortFromSuffix(suffix);
    if (localPort == null) continue;
    const parts = suffix.split('.').filter((p) => p.length > 0);
    const remIndex = parts[2] ?? '0';
    const rowKey = `${localPort}.${remIndex}`;

    let row = rows.get(rowKey);
    if (!row) {
      row = {
        localPort,
        remoteChassisId: '',
        remotePortId: '',
        _remIndex: remIndex,
      };
      rows.set(rowKey, row);
    }

    const decoded = decodeOctet(vb.value);
    switch (col) {
      case 'CHASSIS_ID':
        row.remoteChassisId = decoded;
        break;
      case 'PORT_ID':
        row.remotePortId = decoded;
        break;
      case 'PORT_DESC':
        row.remotePortDesc = decoded;
        break;
      case 'SYS_NAME':
        row.remoteSysName = decoded;
        break;
    }
  }

  return Array.from(rows.values())
    .map(({ _remIndex, ...n }) => n)
    .sort((a, b) => a.localPort - b.localPort);
}
