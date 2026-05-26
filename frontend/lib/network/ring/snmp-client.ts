/**
 * Thin promisified wrapper around net-snmp.
 *
 * Isolates the only module that touches the wire, normalizing net-snmp's
 * varbinds into the library-agnostic `Varbind` shape the parsers consume. Read
 * paths only (GET + GETBULK subtree walks) — nothing is ever written to a
 * switch.
 */

import * as snmp from 'net-snmp';
import type { Varbind, RingSnmpConfig } from './types';

export type SnmpSession = snmp.Session;

export function createSession(ip: string, cfg: RingSnmpConfig): SnmpSession {
  return snmp.createSession(ip, cfg.community, {
    port: cfg.port,
    version: snmp.Version2c,
    timeout: cfg.timeoutMs,
    retries: cfg.retries,
  });
}

export function closeSession(session: SnmpSession): void {
  try {
    session.close();
  } catch {
    /* already closed */
  }
}

function normalize(vb: snmp.Varbind): Varbind {
  if (snmp.isVarbindError(vb)) return { oid: vb.oid, value: null };
  let value = vb.value;
  if (typeof value === 'bigint') value = Number(value);
  return { oid: vb.oid, value: value as Varbind['value'] };
}

/** SNMP GET for a set of scalar/leaf OIDs. Rejects if the host doesn't answer. */
export function snmpGet(session: SnmpSession, oids: string[]): Promise<Varbind[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) return reject(error);
      resolve((varbinds ?? []).map(normalize));
    });
  });
}

/** Walk one column/subtree (GETBULK), collecting every non-error varbind. */
export function snmpWalk(session: SnmpSession, baseOid: string): Promise<Varbind[]> {
  return new Promise((resolve, reject) => {
    const acc: Varbind[] = [];
    session.subtree(
      baseOid,
      20,
      (varbinds) => {
        for (const vb of varbinds) {
          if (!snmp.isVarbindError(vb)) acc.push(normalize(vb));
        }
      },
      (error) => {
        if (error) return reject(error);
        resolve(acc);
      },
    );
  });
}

/** Walk several columns in parallel and concatenate the results. */
export async function snmpWalkColumns(session: SnmpSession, baseOids: string[]): Promise<Varbind[]> {
  const chunks = await Promise.all(baseOids.map((o) => snmpWalk(session, o)));
  return chunks.flat();
}
