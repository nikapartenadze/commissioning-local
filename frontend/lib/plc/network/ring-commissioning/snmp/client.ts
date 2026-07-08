/**
 * Lazy, fail-safe SNMP client for on-demand ring-commissioning reads.
 *
 * The `net-snmp` dependency is require()d lazily the first time a read runs,
 * inside a try/catch. If it is missing or fails to load, reads resolve to
 * { available:false, reason } and the rest of the tool is unaffected. Every
 * read is timeout-bounded and resolves (never rejects), so a slow or dead
 * switch can never hang or crash the caller.
 */
import type { SnmpRow } from './parse'

export interface SnmpCreds {
  version: 'v2c' | 'v3'
  community?: string
  port?: number
  timeoutMs?: number
  retries?: number
}
export type SnmpReadResult = { available: true; rows: SnmpRow[] } | { available: false; reason: string }

/** Lazy, guarded load of the optional net-snmp dependency. Flat shape (not a
 *  discriminated union) so it narrows cleanly under the server tsconfig's
 *  non-strict mode. */
export function loadNetSnmp(): { ok: boolean; mod?: any; reason?: string } {
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
    const finish = (r: SnmpReadResult) => {
      if (done) return
      done = true
      try { session?.close() } catch { /* noop */ }
      resolve(r)
    }
    // Hard backstop in case net-snmp neither calls back nor errors.
    const guard = setTimeout(() => finish({ available: false, reason: `SNMP walk timed out for ${host}` }), (creds.timeoutMs ?? 2000) * 4)
    try {
      const mod = loaded.mod
      session = openSession(mod, host, creds)
      session.on?.('error', (err: any) => { clearTimeout(guard); finish({ available: false, reason: String(err?.message ?? err) }) })
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
    let done = false
    const finish = (r: SnmpReadResult) => {
      if (done) return
      done = true
      try { session?.close() } catch { /* noop */ }
      resolve(r)
    }
    const guard = setTimeout(() => finish({ available: false, reason: `SNMP get timed out for ${host}` }), (creds.timeoutMs ?? 2000) * 4)
    try {
      const mod = loaded.mod
      session = openSession(mod, host, creds)
      session.on?.('error', (err: any) => { clearTimeout(guard); finish({ available: false, reason: String(err?.message ?? err) }) })
      session.get(oids, (error: any, varbinds: any[]) => {
        clearTimeout(guard)
        if (error) return finish({ available: false, reason: String(error.message ?? error) })
        const rows: SnmpRow[] = []
        for (const vb of varbinds ?? []) {
          if (mod.isVarbindError(vb)) continue
          rows.push({ oid: vb.oid, value: String(vb.value) })
        }
        finish({ available: true, rows })
      })
    } catch (e) {
      clearTimeout(guard)
      finish({ available: false, reason: e instanceof Error ? e.message : String(e) })
    }
  })
}
