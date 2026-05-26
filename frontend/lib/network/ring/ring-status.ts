/**
 * Interpret raw Moxa ring/redundancy codes into a RingStatus.
 *
 * Kept separate from SNMP transport so it can be unit-tested, and so the same
 * mapping serves both the SNMP (Moxa private MIB) and the Modbus fallback path
 * — both use the value encodings documented in the Moxa Industrial Protocols
 * guide (see oids.ts).
 */

import type { RingStatus } from './types';
import { RING_PROTOCOL, RING_STATUS_CODE, RING_MASTER_CODE } from './oids';

/** Raw numeric codes pulled from the switch (any may be missing). */
export interface RawRingCodes {
  /** Redundancy protocol code (RING_PROTOCOL). */
  protocol?: number;
  /** Ring health code (0=healthy, 1=break). */
  ringStatus?: number;
  /** Master/slave code (0=slave, 1=master). */
  masterSlave?: number;
}

/** Moxa Modbus registers use 0xFFFF as the "not enabled" sentinel. */
const MODBUS_NOT_ENABLED = 0xffff;
function reg(v: number | undefined): number | undefined {
  return v === undefined || v === MODBUS_NOT_ENABLED ? undefined : v;
}

/**
 * Interpret the Modbus ring registers (per the Moxa Industrial Protocols guide):
 *   0x3000 redundancy protocol, 0x3600 Turbo Ring V2 ring-1 status (0=healthy,
 *   1=break), 0x3601 V2 ring-1 master/slave, 0x3300 (v1) Turbo Ring master/slave.
 * 0xFFFF on any register means "not enabled" and is treated as absent.
 */
export function interpretModbusRing(values: {
  protocol?: number;
  v2Status?: number;
  v2Master?: number;
  v1Master?: number;
}): RingStatus {
  return interpretRingStatus({
    protocol: reg(values.protocol),
    ringStatus: reg(values.v2Status),
    masterSlave: reg(values.v2Master) ?? reg(values.v1Master),
  });
}

export function interpretRingStatus(codes: RawRingCodes): RingStatus {
  const { protocol, ringStatus, masterSlave } = codes;

  // Protocol label.
  let protocolLabel: string;
  if (protocol === undefined) protocolLabel = 'unknown';
  else protocolLabel = RING_PROTOCOL[protocol] ?? `code ${protocol}`;

  // Redundancy disabled outright.
  if (protocol === 0) {
    return { protocol: 'None', health: 'not-enabled', role: 'not-enabled' };
  }

  // Health.
  let health: RingStatus['health'];
  if (ringStatus === RING_STATUS_CODE.HEALTHY) health = 'healthy';
  else if (ringStatus === RING_STATUS_CODE.BREAK) health = 'broken';
  else health = 'unknown';

  // Role.
  let role: RingStatus['role'];
  if (masterSlave === RING_MASTER_CODE.MASTER) role = 'master';
  else if (masterSlave === RING_MASTER_CODE.SLAVE) role = 'slave';
  else role = 'unknown';

  return { protocol: protocolLabel, health, role };
}
