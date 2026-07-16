import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types'
import { computeSyncDiff, type SyncDiffRow, type SyncDiffSummary } from '@/lib/sync/sync-diff'
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
 * READ-ONLY — never mutates local or cloud. Actions go through /diff/actions.
 */

interface CloudPayloadIo { id: number | string; name?: string; result?: string | null; comments?: string | null; version?: number; timestamp?: string | null }

async function fetchCloud(subsystemId: number, remoteUrl: string, apiPassword: string): Promise<{ ok: boolean; ios?: CloudPayloadIo[]; error?: string }> {
  try {
    const res = await fetch(`${remoteUrl}/api/sync/subsystem/${subsystemId}`, {
      method: 'GET',
      headers: { 'X-API-Key': apiPassword },
      signal: AbortSignal.timeout(25_000),
    })
    if (res.status === 403 || res.status === 401) return { ok: false, error: `Not authorized for subsystem ${subsystemId} (HTTP ${res.status})` }
    if (!res.ok) return { ok: false, error: `Cloud returned ${res.status}` }
    const body = await res.json()
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

interface PerSubsystemDiff {
  subsystemId: number
  mcm: string | null
  ok: boolean
  error?: string
  summary?: SyncDiffSummary
  rows?: SyncDiffRow[]
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

    for (const t of targets) {
      const cloud = await fetchCloud(t.subsystemId, remoteUrl, apiPassword)
      if (!cloud.ok) {
        perSubsystem.push({ subsystemId: t.subsystemId, mcm: t.mcm, ok: false, error: cloud.error })
        continue
      }
      const local = localRowsFor(t.subsystemId)
      const cloudIos: Array<CloudIoState & { name?: string | null; timestamp?: string | null }> =
        (cloud.ios ?? []).map((c) => ({ id: c.id, result: c.result ?? null, comments: c.comments ?? null, version: c.version, name: c.name ?? null, timestamp: c.timestamp ?? null }))
      const { rows, summary } = computeSyncDiff(local, cloudIos)
      perSubsystem.push({ subsystemId: t.subsystemId, mcm: t.mcm, ok: true, summary, rows })
      for (const k of Object.keys(agg) as (keyof SyncDiffSummary)[]) agg[k] += summary[k]
    }

    return res.json({ success: true, summary: agg, perSubsystem })
  } catch (error) {
    console.error('Sync diff failed:', error)
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Internal error' })
  }
}
