/**
 * Ring scan orchestrator.
 *
 * Fans out read-only SNMP queries to every switch in a ring (in parallel), and
 * assembles a RingScanResult. A switch that doesn't answer is recorded as
 * `reachable: false` — it never aborts the rest of the scan.
 */

import type {
  RingSnmpConfig, RingScanResult, DpmScan, RingStatus, Varbind, ModbusRingConfig,
} from './types';
import { createSession, closeSession, snmpGet, snmpWalkColumns, SnmpSession } from './snmp-client';
import { parseLldpNeighbors, decodeOctet } from './lldp';
import { parsePortStats } from './if-mib';
import { interpretRingStatus, interpretModbusRing, RawRingCodes } from './ring-status';
import { readInputRegisters, ModbusReadOptions } from './modbus-client';
import { LLDP_REM, IF_MIB, ETHERLIKE, SYS_NAME, MoxaRingOids } from './oids';

/** lldpLocChassisId.0 — this switch's own chassis id, used to resolve neighbors. */
const LLDP_LOC_CHASSIS_ID = '1.0.8802.1.1.2.1.3.2.0';

const UNKNOWN_RING: RingStatus = { protocol: 'unknown', health: 'unknown', role: 'unknown' };

export interface DpmTarget {
  dpmName: string;
  ip: string;
}

export interface ScanOptions {
  snmp: RingSnmpConfig;
  /** Optional Moxa private-MIB scalar OIDs for ring state (resolved per switch model). */
  ringOids?: MoxaRingOids;
  /** Optional Modbus/TCP fallback for ring state when SNMP doesn't expose it. */
  modbus?: ModbusRingConfig;
}

// Moxa Modbus ring registers (Industrial Protocols guide).
const MODBUS_REG = {
  PROTOCOL: 0x3000,
  V2_RING1: 0x3600, // +0 status (0=healthy,1=break), +1 master/slave
  V1_MASTER: 0x3300,
} as const;

export interface ScanRingParams {
  ringId: number;
  ringName: string;
  targets: DpmTarget[];
  options: ScanOptions;
}

function valueOf(varbinds: Varbind[], oid: string): Varbind['value'] {
  return varbinds.find((v) => v.oid === oid)?.value ?? null;
}

function numOf(varbinds: Varbind[], oid: string): number | undefined {
  const v = valueOf(varbinds, oid);
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function readRingSnmp(session: SnmpSession, ringOids?: MoxaRingOids): Promise<RingStatus> {
  const oids = [ringOids?.protocol, ringOids?.ringStatus, ringOids?.masterSlave].filter(
    (o): o is string => !!o,
  );
  if (oids.length === 0) return UNKNOWN_RING;
  try {
    const vbs = await snmpGet(session, oids);
    const codes: RawRingCodes = {};
    if (ringOids?.protocol) codes.protocol = numOf(vbs, ringOids.protocol);
    if (ringOids?.ringStatus) codes.ringStatus = numOf(vbs, ringOids.ringStatus);
    if (ringOids?.masterSlave) codes.masterSlave = numOf(vbs, ringOids.masterSlave);
    return interpretRingStatus(codes);
  } catch {
    return UNKNOWN_RING;
  }
}

async function tryReadRegisters(
  ip: string, o: ModbusReadOptions, addr: number, qty: number,
): Promise<number[] | null> {
  try {
    return await readInputRegisters(ip, o, addr, qty);
  } catch {
    return null;
  }
}

async function readRingModbus(ip: string, cfg: ModbusRingConfig): Promise<RingStatus> {
  const o: ModbusReadOptions = { port: cfg.port, unitId: cfg.unitId, timeoutMs: cfg.timeoutMs };
  const proto = await tryReadRegisters(ip, o, MODBUS_REG.PROTOCOL, 1);
  const v2 = await tryReadRegisters(ip, o, MODBUS_REG.V2_RING1, 2);
  const v1 = await tryReadRegisters(ip, o, MODBUS_REG.V1_MASTER, 1);
  return interpretModbusRing({
    protocol: proto?.[0],
    v2Status: v2?.[0],
    v2Master: v2?.[1],
    v1Master: v1?.[0],
  });
}

/** SNMP first; if it can't determine ring health and Modbus is enabled, fall back. */
async function readRing(ip: string, session: SnmpSession, options: ScanOptions): Promise<RingStatus> {
  const viaSnmp = await readRingSnmp(session, options.ringOids);
  if (viaSnmp.health !== 'unknown') return viaSnmp;
  if (options.modbus?.enabled) {
    try {
      const viaModbus = await readRingModbus(ip, options.modbus);
      if (viaModbus.health !== 'unknown') return viaModbus;
    } catch {
      /* fall through to the SNMP (unknown) result */
    }
  }
  return viaSnmp;
}

async function scanDpm(target: DpmTarget, options: ScanOptions): Promise<DpmScan> {
  const scannedAt = Date.now();
  const base = { dpmName: target.dpmName, ip: target.ip, scannedAt };
  const session = createSession(target.ip, options.snmp);
  try {
    // Reachability probe + identity (sysName, local chassis id).
    const scalars = await snmpGet(session, [SYS_NAME, LLDP_LOC_CHASSIS_ID]);
    const sysName = decodeOctet(valueOf(scalars, SYS_NAME)) || undefined;
    const localChassisId = decodeOctet(valueOf(scalars, LLDP_LOC_CHASSIS_ID)) || undefined;

    const [lldpVbs, ifVbs] = await Promise.all([
      snmpWalkColumns(session, [
        LLDP_REM.CHASSIS_ID,
        LLDP_REM.PORT_ID,
        LLDP_REM.PORT_DESC,
        LLDP_REM.SYS_NAME,
      ]),
      snmpWalkColumns(session, [
        IF_MIB.OPER_STATUS,
        IF_MIB.SPEED,
        IF_MIB.HIGH_SPEED,
        IF_MIB.IN_ERRORS,
        IF_MIB.OUT_ERRORS,
        ETHERLIKE.ALIGNMENT_ERRORS,
        ETHERLIKE.FCS_ERRORS,
        ETHERLIKE.DUPLEX_STATUS,
      ]),
    ]);

    const ring = await readRing(target.ip, session, options);

    return {
      ...base,
      reachable: true,
      sysName,
      localChassisId,
      neighbors: parseLldpNeighbors(lldpVbs),
      ports: parsePortStats(ifVbs),
      ring,
    };
  } catch (err) {
    return {
      ...base,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
      neighbors: [],
      ports: [],
      ring: UNKNOWN_RING,
    };
  } finally {
    closeSession(session);
  }
}

/** Scan every switch in the ring and return the assembled result. */
export async function scanRing(params: ScanRingParams): Promise<RingScanResult> {
  const scannedAt = Date.now();
  const dpms = await Promise.all(params.targets.map((t) => scanDpm(t, params.options)));
  return { ringId: params.ringId, ringName: params.ringName, scannedAt, dpms };
}
