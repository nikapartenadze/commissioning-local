/**
 * Config side-pulls: network / e-stop / safety / punchlist for one subsystem.
 *
 * Extracted from the per-MCM pull route (app/api/mcm/[subsystemId]/pull) so the
 * SAME idempotent logic can run in BOTH the full-pull path and the no-op
 * short-circuit path. Before this, the no-op short-circuit (IO hash unchanged)
 * returned early and skipped all of these, so cloud-side FV/config changes only
 * reached the field after a service restart cleared the in-memory hash. Safety
 * was also DELETEd by the pull transaction but never re-inserted (data loss) —
 * it is now a first-class section here.
 *
 * Each section is a self-contained, subsystem-scoped delete-then-insert unit:
 *  - It only rewrites the given subsystem's rows (other MCMs are never touched).
 *  - Running it twice yields the same rows (idempotent — no duplication).
 *  - A transient cloud failure SKIPS that section (keeps existing local rows);
 *    it never wipes on a failed/empty fetch. Sections are independent — one
 *    failing does not abort the others.
 *
 * The L2/FV pull is intentionally NOT here: it is a self-call to
 * /api/cloud/pull-l2 (which does its own scoped delete+insert) and stays in the
 * route so this module has no HTTP-server dependency and is unit-testable.
 */

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

interface Stmt {
  run: (...args: unknown[]) => { lastInsertRowid: number | bigint; changes: number }
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
}
interface Db {
  prepare: (sql: string) => Stmt
}

export interface SidePullDeps {
  db: Db
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike
}

export interface SidePullResult {
  networkPulled: number
  estopPulled: number
  safetyPulled: number
  punchlistsPulled: number
  guidedTaskStatesPulled: number
}

/**
 * Parse a stored timestamp into epoch ms for LWW comparison. Local SQLite
 * writes `datetime('now')` ('YYYY-MM-DD HH:MM:SS', UTC, no marker) while the
 * cloud serves ISO-8601 with 'Z' — treat a marker-less string as UTC so the
 * two are comparable.
 */
function parseUtcMs(s: string | null | undefined): number {
  if (!s) return 0
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

interface CloudGuidedTaskState {
  taskId?: string
  status?: string
  reason?: string | null
  actorName?: string | null
  updatedAt?: string | null
}

/**
 * Pull guided-mode task-state OVERRIDES (skip-with-reason / manual mark-done /
 * cleared) back from the cloud for one subsystem. Closes the down-flow gap:
 * these rows pushed UP since 2026-06-09 but a fresh install or peer laptop
 * never got them back, so skipped tasks reappeared as available.
 *
 * Merge rules mirror the e-stop check down-flow (never-clobber):
 *  - SKIP any task with an un-pushed local edit (GuidedTaskStatePendingSyncs
 *    row = local truth, including dead-lettered rows).
 *  - INSERT when local has no row (unless the cloud state is 'cleared').
 *  - Apply only when the cloud UpdatedAt is STRICTLY newer than local
 *    (ties keep local — the field is the authoring side).
 *  - 'cleared' is an undo tombstone → DELETE the local row.
 *
 * Best-effort: never throws, returns the number of applied states.
 */
export async function pullGuidedTaskStates(
  subsystemId: number,
  remoteUrl: string,
  apiPassword: string,
  deps: SidePullDeps,
): Promise<number> {
  const db = deps.db
  const doFetch: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const base = remoteUrl.replace(/\/$/, '')
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' }
  let applied = 0
  try {
    const res = await doFetch(`${base}/api/sync/guided-task-state?subsystemId=${subsystemId}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return 0
    const data = (await res.json()) as { success?: boolean; states?: CloudGuidedTaskState[] }
    if (!data.success || !Array.isArray(data.states) || data.states.length === 0) return 0

    const hasPending = db.prepare('SELECT COUNT(*) c FROM GuidedTaskStatePendingSyncs WHERE SubsystemId = ? AND TaskId = ?')
    const getLocal = db.prepare('SELECT id, UpdatedAt FROM GuidedTaskState WHERE SubsystemId = ? AND TaskId = ?')
    const ins = db.prepare(`INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, Reason, ActorName, UpdatedAt)
                            VALUES (?, ?, ?, ?, ?, ?)`)
    const upd = db.prepare('UPDATE GuidedTaskState SET Status=?, Reason=?, ActorName=?, UpdatedAt=? WHERE id=?')
    const del = db.prepare('DELETE FROM GuidedTaskState WHERE id=?')

    for (const s of data.states) {
      if (!s?.taskId || typeof s.taskId !== 'string') continue
      const status = typeof s.status === 'string' ? s.status : ''
      // Only the statuses this contract defines; anything else is ignored.
      if (status !== 'skipped' && status !== 'completed' && status !== 'cleared') continue
      if ((hasPending.get(subsystemId, s.taskId) as { c: number }).c > 0) continue

      const cloudTs = parseUtcMs(s.updatedAt)
      const local = getLocal.get(subsystemId, s.taskId) as { id: number; UpdatedAt: string | null } | undefined

      if (!local) {
        if (status === 'cleared') continue // nothing to undo locally
        ins.run(subsystemId, s.taskId, status, s.reason ?? null, s.actorName ?? null, s.updatedAt ?? new Date().toISOString())
        applied++
        continue
      }

      if (cloudTs <= parseUtcMs(local.UpdatedAt)) continue // local same-or-newer wins

      if (status === 'cleared') {
        del.run(local.id)
      } else {
        upd.run(status, s.reason ?? null, s.actorName ?? null, s.updatedAt ?? new Date().toISOString(), local.id)
      }
      applied++
    }
    if (applied > 0) console.log(`[SidePull ${subsystemId}] guided task states applied from cloud: ${applied}`)
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] guided task-state failed:`, e instanceof Error ? e.message : e)
  }
  return applied
}

const TIMEOUT_MS = 15_000

export async function runConfigSidePulls(
  subsystemId: number,
  remoteUrl: string,
  apiPassword: string,
  deps: SidePullDeps,
): Promise<SidePullResult> {
  const db = deps.db
  const doFetch: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const base = remoteUrl.replace(/\/$/, '')
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' }
  const result: SidePullResult = { networkPulled: 0, estopPulled: 0, safetyPulled: 0, punchlistsPulled: 0, guidedTaskStatesPulled: 0 }

  // ── Network topology ────────────────────────────────────────────────────
  try {
    const res = await doFetch(`${base}/api/network?subsystemId=${subsystemId}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        success?: boolean
        rings?: Array<{
          name: string; mcmName: string; mcmIp?: string; mcmTag?: string
          nodes?: Array<{
            name: string; position: number; ipAddress?: string; cableIn?: string; cableOut?: string
            statusTag?: string; totalPorts?: number
            ports?: Array<{ portNumber: number; cableLabel?: string; deviceName?: string; deviceType?: string; deviceIp?: string; statusTag?: string }>
          }>
        }>
      }
      if (data.success && data.rings && data.rings.length > 0) {
        // Scoped delete (children first) then re-insert.
        db.prepare(`DELETE FROM NetworkPorts WHERE NodeId IN (SELECT id FROM NetworkNodes WHERE RingId IN (SELECT id FROM NetworkRings WHERE SubsystemId = ?))`).run(subsystemId)
        db.prepare(`DELETE FROM NetworkNodes WHERE RingId IN (SELECT id FROM NetworkRings WHERE SubsystemId = ?)`).run(subsystemId)
        db.prepare('DELETE FROM NetworkRings WHERE SubsystemId = ?').run(subsystemId)
        const insertRing = db.prepare('INSERT INTO NetworkRings (SubsystemId, Name, McmName, McmIp, McmTag) VALUES (?, ?, ?, ?, ?)')
        const insertNode = db.prepare('INSERT INTO NetworkNodes (RingId, Name, Position, IpAddress, CableIn, CableOut, StatusTag, TotalPorts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        const insertPort = db.prepare('INSERT INTO NetworkPorts (NodeId, PortNumber, CableLabel, DeviceName, DeviceType, DeviceIp, StatusTag, ParentPortId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        for (const ring of data.rings) {
          const rr = insertRing.run(subsystemId, ring.name, ring.mcmName, ring.mcmIp || null, ring.mcmTag || null)
          const ringId = rr.lastInsertRowid
          for (const node of ring.nodes || []) {
            const nr = insertNode.run(ringId, node.name, node.position, node.ipAddress || null, node.cableIn || null, node.cableOut || null, node.statusTag || null, node.totalPorts || 28)
            const nodeId = nr.lastInsertRowid
            for (const port of node.ports || []) {
              insertPort.run(nodeId, port.portNumber, port.cableLabel || null, port.deviceName || null, port.deviceType || null, port.deviceIp || null, port.statusTag || null, null)
            }
          }
        }
        result.networkPulled = data.rings.length
      }
    }
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] network failed:`, e instanceof Error ? e.message : e)
  }

  // ── E-Stop zones / EPCs / IO points / VFDs ────────────────────────────────
  try {
    const res = await doFetch(`${base}/api/sync/estop?subsystemId=${subsystemId}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        success?: boolean
        zones?: Array<{ name: string; epcs?: Array<{ name: string; checkTag: string; ioPoints?: Array<{ tag: string }>; vfds?: Array<{ tag: string; stoTag: string; mustStop?: boolean }>; relatedEpcs?: Array<{ tag: string; mustDrop?: boolean }> }> }>
        // Check RESULTS (2026-07-08 e-stop down-flow): additive field served by
        // newer clouds; absent on older clouds and safely ignored below.
        checks?: Array<{ zoneName: string; checkTag: string; checkType?: string; result?: string | null; comments?: string | null; failureMode?: string | null; testedBy?: string | null; testedAt?: string | null; version?: number }>
      }
      if (data.success && data.zones && data.zones.length > 0) {
        db.prepare(`DELETE FROM EStopIoPoints WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?))`).run(subsystemId)
        db.prepare(`DELETE FROM EStopVfds WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?))`).run(subsystemId)
        // EStopRelatedEpcs (the must-drop / must-stay-OK companion e-stops)
        // cascade-delete with EStopEpcs (FK ON DELETE CASCADE, foreign_keys=ON),
        // so they MUST be re-inserted below or the primary pull path silently
        // loses them (the manual pull-estop route already handles them).
        db.prepare(`DELETE FROM EStopRelatedEpcs WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?))`).run(subsystemId)
        db.prepare(`DELETE FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?)`).run(subsystemId)
        db.prepare('DELETE FROM EStopZones WHERE SubsystemId = ?').run(subsystemId)
        const insertZone = db.prepare('INSERT INTO EStopZones (SubsystemId, Name) VALUES (?, ?)')
        const insertEpc = db.prepare('INSERT INTO EStopEpcs (ZoneId, Name, CheckTag) VALUES (?, ?, ?)')
        const insertIoPoint = db.prepare('INSERT INTO EStopIoPoints (EpcId, Tag) VALUES (?, ?)')
        const insertVfd = db.prepare('INSERT INTO EStopVfds (EpcId, Tag, StoTag, MustStop) VALUES (?, ?, ?, ?)')
        const insertRelatedEpc = db.prepare('INSERT INTO EStopRelatedEpcs (EpcId, Tag, MustDrop) VALUES (?, ?, ?)')
        for (const zone of data.zones) {
          const zr = insertZone.run(subsystemId, zone.name)
          const zoneId = zr.lastInsertRowid
          for (const epc of zone.epcs || []) {
            const er = insertEpc.run(zoneId, epc.name, epc.checkTag)
            const epcId = er.lastInsertRowid
            for (const io of epc.ioPoints || []) insertIoPoint.run(epcId, io.tag)
            for (const vfd of epc.vfds || []) insertVfd.run(epcId, vfd.tag, vfd.stoTag, vfd.mustStop ? 1 : 0)
            for (const rel of epc.relatedEpcs || []) insertRelatedEpc.run(epcId, rel.tag, rel.mustDrop ? 1 : 0)
          }
        }
        result.estopPulled = data.zones.length
      }

      // ── E-stop check RESULTS apply (2026-07-08 down-flow) ───────────────
      // Version-gated, never-clobber merge of peer/cloud results into the local
      // ledger — this is what lets a REPLACED tablet recover safety-check
      // results, and peers converge. Rules: INSERT when local has no row;
      // UPDATE only when cloud.version is strictly newer; SKIP any check with
      // an un-pushed local edit (EStopCheckPendingSyncs row = local truth).
      if (data.success && Array.isArray(data.checks) && data.checks.length > 0) {
        const getLocal = db.prepare('SELECT id, Version FROM EStopEpcChecks WHERE SubsystemId=? AND ZoneName=? AND CheckTag=? AND CheckType=?')
        const hasPending = db.prepare('SELECT COUNT(*) c FROM EStopCheckPendingSyncs WHERE SubsystemId=? AND ZoneName=? AND CheckTag=? AND CheckType=?')
        const ins = db.prepare(`INSERT INTO EStopEpcChecks (SubsystemId, ZoneName, CheckTag, CheckType, Result, Comments, FailureMode, TestedBy, TestedAt, Version, UpdatedAt)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        const upd = db.prepare(`UPDATE EStopEpcChecks SET Result=?, Comments=?, FailureMode=?, TestedBy=?, TestedAt=?, Version=?, UpdatedAt=datetime('now') WHERE id=?`)
        let applied = 0
        for (const c of data.checks) {
          if (!c?.zoneName || !c?.checkTag) continue
          const checkType = c.checkType || 'preliminary'
          const ver = Number(c.version) || 1
          if ((hasPending.get(subsystemId, c.zoneName, c.checkTag, checkType) as { c: number }).c > 0) continue
          const local = getLocal.get(subsystemId, c.zoneName, c.checkTag, checkType) as { id: number; Version: number } | undefined
          if (!local) {
            ins.run(subsystemId, c.zoneName, c.checkTag, checkType, c.result ?? null, c.comments ?? null, c.failureMode ?? null, c.testedBy ?? null, c.testedAt ?? null, ver)
            applied++
          } else if (ver > (local.Version ?? 0)) {
            upd.run(c.result ?? null, c.comments ?? null, c.failureMode ?? null, c.testedBy ?? null, c.testedAt ?? null, ver, local.id)
            applied++
          }
        }
        if (applied > 0) console.log(`[SidePull ${subsystemId}] estop check results applied from cloud: ${applied}`)
      }
    }
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] estop failed:`, e instanceof Error ? e.message : e)
  }

  // ── Safety zones / drives / outputs ───────────────────────────────────────
  // Regression guard: the pull used to DELETE these and never re-insert them.
  // Creds go in the X-API-Key header like every other call (F18) — the old
  // ?apiKey= query param leaked the key into proxy/access logs.
  try {
    const res = await doFetch(`${base}/api/sync/safety?subsystemId=${subsystemId}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        success?: boolean
        zones?: Array<{ name: string; stoSignal?: string; bssTag?: string; drives?: Array<{ name: string }> }>
        outputs?: Array<{ tag: string; description?: string; outputType?: string }>
      }
      if (data.success && ((data.zones && data.zones.length > 0) || (data.outputs && data.outputs.length > 0))) {
        db.prepare(`DELETE FROM SafetyZoneDrives WHERE ZoneId IN (SELECT id FROM SafetyZones WHERE SubsystemId = ?)`).run(subsystemId)
        db.prepare('DELETE FROM SafetyZones WHERE SubsystemId = ?').run(subsystemId)
        db.prepare('DELETE FROM SafetyOutputs WHERE SubsystemId = ?').run(subsystemId)
        const insertZone = db.prepare('INSERT INTO SafetyZones (SubsystemId, Name, StoSignal, BssTag) VALUES (?, ?, ?, ?)')
        const insertDrive = db.prepare('INSERT INTO SafetyZoneDrives (ZoneId, Name) VALUES (?, ?)')
        const insertOutput = db.prepare('INSERT INTO SafetyOutputs (SubsystemId, Tag, Description, OutputType) VALUES (?, ?, ?, ?)')
        for (const zone of data.zones || []) {
          const zr = insertZone.run(subsystemId, zone.name, zone.stoSignal || null, zone.bssTag || null)
          const zoneId = zr.lastInsertRowid
          for (const d of zone.drives || []) insertDrive.run(zoneId, d.name)
        }
        for (const o of data.outputs || []) insertOutput.run(subsystemId, o.tag, o.description || null, o.outputType || null)
        result.safetyPulled = (data.zones || []).length
      }
    }
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] safety failed:`, e instanceof Error ? e.message : e)
  }

  // ── Punchlists ────────────────────────────────────────────────────────────
  try {
    const res = await doFetch(`${base}/api/sync/punchlists?subsystemId=${subsystemId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = (await res.json()) as { punchlists?: Array<{ id: number; name: string; ioIds?: number[] }> }
      if (data.punchlists && data.punchlists.length > 0) {
        db.prepare(`DELETE FROM PunchlistItems WHERE PunchlistId IN (SELECT id FROM Punchlists WHERE SubsystemId = ?)`).run(subsystemId)
        db.prepare('DELETE FROM Punchlists WHERE SubsystemId = ?').run(subsystemId)
        const insertPunchlist = db.prepare('INSERT OR REPLACE INTO Punchlists (id, Name, SubsystemId) VALUES (?, ?, ?)')
        const insertItem = db.prepare('INSERT OR IGNORE INTO PunchlistItems (PunchlistId, IoId) VALUES (?, ?)')
        for (const pl of data.punchlists) {
          insertPunchlist.run(pl.id, pl.name, subsystemId)
          for (const ioId of pl.ioIds || []) insertItem.run(pl.id, ioId)
          result.punchlistsPulled++
        }
      }
    }
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] punchlist failed:`, e instanceof Error ? e.message : e)
  }

  // ── Guided-mode task-state overrides (skip / mark-done / cleared) ─────────
  // Down-flow so a fresh install or peer laptop restores skips + manual
  // completes. Never-clobber merge — see pullGuidedTaskStates.
  result.guidedTaskStatesPulled = await pullGuidedTaskStates(subsystemId, remoteUrl, apiPassword, deps)

  return result
}
