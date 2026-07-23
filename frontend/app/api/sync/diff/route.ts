import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types'
import {
  computeSyncDiff,
  selectDivergentCandidates,
  type SyncDiffRow,
  type SyncDiffSummary,
  type VersionManifestEntry,
} from '@/lib/sync/sync-diff'
import type { LocalResultRow, CloudIoState } from '@/lib/cloud/result-reconciler'

/**
 * GET /api/sync/diff[?subsystemId=]
 *
 * Per-MCM (or all managed MCMs) version-aware comparison of LOCAL results against
 * the CLOUD. Powers the Sync Center "Compare with Cloud" view: for every IO that
 * diverges it says what's different and why, and the recommended action (push a
 * newer local result, accept a newer cloud value that makes the local one stale,
 * tombstone a removed-on-cloud IO, or pull a cloud-only value).
 *
 * FAST + COMPLETE. It never pulls the whole subsystem (payloads + every
 * testHistory) and deep-compares everything. Instead, per subsystem it:
 *   (a) reads the local result/comment rows (localRowsFor);
 *   (b) reads the OUTBOX ids (active PendingSyncs, DeadLettered=0);
 *   (c) GETs a cheap id→version MANIFEST (/versions — no payloads);
 *   (d) computes the DIVERGENT candidate id set from (a)+(b)+(c) — version
 *       mismatches, local-only orphans, written cloud-only rows, and every
 *       outbox id (see selectDivergentCandidates);
 *   (e) POSTs /rows { ids } to fetch full cloud VALUES for ONLY those candidates;
 *   (f) classifies just the candidate set (computeSyncDiff), then corrects
 *       total/inSync against the full local+manifest population.
 * Net: O(divergent) payloads and zero testHistories, instead of O(all IOs).
 *
 * READ-ONLY — never mutates local or cloud. Actions go through /diff/actions.
 */

interface CloudPayloadIo { id: number | string; name?: string; result?: string | null; comments?: string | null; version?: number; timestamp?: string | null }

/** GET the cheap id→version manifest for a subsystem (no payloads). */
async function fetchVersions(subsystemId: number, remoteUrl: string, apiPassword: string): Promise<{ ok: boolean; ios?: VersionManifestEntry[]; error?: string }> {
  try {
    const res = await fetch(`${remoteUrl}/api/sync/subsystem/${subsystemId}/versions`, {
      method: 'GET',
      headers: { 'X-API-Key': apiPassword },
      signal: AbortSignal.timeout(25_000),
    })
    if (res.status === 403 || res.status === 401) return { ok: false, error: `Not authorized for subsystem ${subsystemId} (HTTP ${res.status})` }
    if (!res.ok) return { ok: false, error: `Cloud returned ${res.status}` }
    const body = await res.json()
    if (body?.success === false) return { ok: false, error: body.error || 'cloud success=false' }
    const ios = (body.ios || []) as Array<{ id: number | string; version: number | string }>
    return { ok: true, ios: ios.map((v) => ({ id: Number(v.id), version: Number(v.version) || 0 })) }
  } catch (err) {
    return { ok: false, error: `Cloud unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** POST /rows to fetch full cloud values for ONLY the divergent candidate ids. */
async function fetchRows(subsystemId: number, ids: number[], remoteUrl: string, apiPassword: string): Promise<{ ok: boolean; ios?: CloudPayloadIo[]; error?: string }> {
  if (ids.length === 0) return { ok: true, ios: [] }
  try {
    const res = await fetch(`${remoteUrl}/api/sync/subsystem/${subsystemId}/rows`, {
      method: 'POST',
      headers: { 'X-API-Key': apiPassword, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(25_000),
    })
    if (res.status === 403 || res.status === 401) return { ok: false, error: `Not authorized for subsystem ${subsystemId} (HTTP ${res.status})` }
    if (!res.ok) return { ok: false, error: `Cloud returned ${res.status}` }
    const body = await res.json()
    if (body?.success === false) return { ok: false, error: body.error || 'cloud success=false' }
    return { ok: true, ios: (body.ios || body.Ios || []) as CloudPayloadIo[] }
  } catch (err) {
    return { ok: false, error: `Cloud unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function localRowsFor(subsystemId: number): Array<LocalResultRow & { Name: string | null }> {
  return db.prepare(
    `SELECT id, Name, Result, Comments, TestedBy, Timestamp, Version, Trade, FailureMode
       FROM Ios
      WHERE SubsystemId = ?
        AND ((Result IS NOT NULL AND Result != '') OR (Comments IS NOT NULL AND TRIM(Comments) != ''))
        AND COALESCE(CloudRemoved,0) = 0`,
  ).all(subsystemId) as Array<LocalResultRow & { Name: string | null }>
}

/**
 * The OUTBOX for a subsystem: ids with an ACTIVE pending local edit. Same
 * local-ahead set the reconciler reads (result-reconciler.ts:193-197), scoped to
 * DeadLettered=0 — a parked row is not local-ahead; if it still diverges the
 * manifest surfaces it as a version/orphan candidate instead.
 */
function outboxIdsFor(subsystemId: number): Set<number> {
  const rows = db.prepare(
    `SELECT DISTINCT ps.IoId FROM PendingSyncs ps
       JOIN Ios i ON i.id = ps.IoId
      WHERE i.SubsystemId = ? AND ps.DeadLettered = 0`,
  ).all(subsystemId) as Array<{ IoId: number }>
  return new Set<number>(rows.map((r) => Number(r.IoId)))
}

interface PerSubsystemDiff {
  subsystemId: number
  mcm: string | null
  ok: boolean
  error?: string
  summary?: SyncDiffSummary
  rows?: SyncDiffRow[]
}

/** Compute one subsystem's diff via manifest + outbox + targeted /rows fetch. */
async function diffSubsystem(subsystemId: number, remoteUrl: string, apiPassword: string): Promise<{ ok: boolean; summary?: SyncDiffSummary; rows?: SyncDiffRow[]; error?: string }> {
  const versions = await fetchVersions(subsystemId, remoteUrl, apiPassword)
  if (!versions.ok) return { ok: false, error: versions.error || 'versions fetch failed' }

  const local = localRowsFor(subsystemId)
  const manifest = versions.ios ?? []
  const outboxIds = outboxIdsFor(subsystemId)

  // Only the divergent candidates need full cloud values fetched.
  const candidateIds = selectDivergentCandidates(local, manifest, outboxIds)
  const rowsResp = await fetchRows(subsystemId, Array.from(candidateIds), remoteUrl, apiPassword)
  if (!rowsResp.ok) return { ok: false, error: rowsResp.error || 'rows fetch failed' }

  // Build the cloud map from the fetched values. For a candidate the manifest
  // says the cloud HAS (any id in the manifest) but /rows didn't return, keep a
  // truthful "cloud has the IO, no result at manifest version" entry rather than
  // letting it fall through to gone_on_cloud — only a manifest-ABSENT id (a real
  // local orphan) may become gone_on_cloud.
  const manifestVersionById = new Map<number, number>(manifest.map((m) => [Number(m.id), Number(m.version) || 0]))
  const cloudById = new Map<number, CloudIoState & { name?: string | null; timestamp?: string | null }>()
  for (const c of rowsResp.ios ?? []) {
    cloudById.set(Number(c.id), { id: Number(c.id), result: c.result ?? null, comments: c.comments ?? null, version: c.version, name: c.name ?? null, timestamp: c.timestamp ?? null })
  }
  for (const id of Array.from(candidateIds)) {
    if (!cloudById.has(id) && manifestVersionById.has(id)) {
      cloudById.set(id, { id, result: null, comments: null, version: manifestVersionById.get(id), name: null, timestamp: null })
    }
  }

  const localCandidates = local.filter((r) => candidateIds.has(Number(r.id)))
  const { rows, summary } = computeSyncDiff(localCandidates, Array.from(cloudById.values()), outboxIds)

  // computeSyncDiff only saw the candidates; correct the whole-population
  // total/inSync against the full local+manifest universe (every non-candidate
  // is in_sync by construction). This matches the population the old full-pull
  // counted (local result/comment rows ∪ all cloud ios), minus the payloads.
  const universe = new Set<number>([...local.map((r) => Number(r.id)), ...manifest.map((m) => Number(m.id))])
  summary.total = universe.size
  summary.inSync = summary.total - summary.push - summary.acceptCloud - summary.tombstone - summary.pull - summary.conflict

  return { ok: true, summary, rows }
}

export async function GET(req: Request, res: Response) {
  try {
    const cfg = await configService.getConfig()
    const remoteUrl = (cfg.remoteUrl || EMBEDDED_REMOTE_URL).replace(/\/+$/, '')
    const apiPassword = cfg.apiPassword || ''
    if (!remoteUrl || !apiPassword) {
      return res.status(400).json({ success: false, error: 'Cloud URL / API key not configured' })
    }

    const sidRaw = req.query.subsystemId
    const one = sidRaw != null && String(sidRaw).trim() !== '' && String(sidRaw).trim() !== 'all'
      ? Number(sidRaw)
      : null

    // Resolve target subsystems: one, or every configured MCM.
    let targets: Array<{ subsystemId: number; mcm: string | null }> = []
    if (one != null && Number.isFinite(one)) {
      const mcm = (db.prepare('SELECT Name FROM Subsystems WHERE id = ?').get(one) as { Name?: string } | undefined)?.Name ?? null
      targets = [{ subsystemId: one, mcm }]
    } else {
      const mcms = await configService.getMcms().catch(() => [])
      targets = mcms
        .filter((m) => m.enabled !== false)
        .map((m) => ({ subsystemId: parseInt(m.subsystemId, 10), mcm: m.name ?? null }))
        .filter((t) => Number.isFinite(t.subsystemId) && t.subsystemId > 0)
      if (targets.length === 0 && cfg.subsystemId) {
        const sid = parseInt(String(cfg.subsystemId), 10)
        if (Number.isFinite(sid)) targets = [{ subsystemId: sid, mcm: null }]
      }
    }

    const perSubsystem: PerSubsystemDiff[] = []
    const agg: SyncDiffSummary = { total: 0, inSync: 0, push: 0, acceptCloud: 0, tombstone: 0, pull: 0, conflict: 0 }

    // Per subsystem the fan-out is now cheap: 1 metadata GET + (at most) 1 rows
    // POST for only the divergent ids. An all-in-sync MCM never fetches a payload.
    for (const t of targets) {
      const result = await diffSubsystem(t.subsystemId, remoteUrl, apiPassword)
      if (!result.ok || !result.summary) {
        perSubsystem.push({ subsystemId: t.subsystemId, mcm: t.mcm, ok: false, error: result.error })
        continue
      }
      perSubsystem.push({ subsystemId: t.subsystemId, mcm: t.mcm, ok: true, summary: result.summary, rows: result.rows })
      for (const k of Object.keys(agg) as (keyof SyncDiffSummary)[]) agg[k] += result.summary[k]
    }

    return res.json({ success: true, summary: agg, perSubsystem })
  } catch (error) {
    console.error('Sync diff failed:', error)
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Internal error' })
  }
}
