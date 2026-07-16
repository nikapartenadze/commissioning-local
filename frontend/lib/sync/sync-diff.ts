/**
 * Sync Diff — the per-IO, version-aware comparison of LOCAL results against the
 * CLOUD payload. This is the "compare to cloud, know what's wrong and why" layer
 * the operator asked for, and the basis for the Sync Center's Compare view.
 *
 * PURE + queue-independent: it looks at `Ios` (the local result source of truth)
 * vs the cloud subsystem payload, exactly like the pull guard, but instead of a
 * single "would erase" count it classifies EVERY divergence and recommends an
 * action:
 *   - local newer / only-local  → PUSH   (local wins — send it up)
 *   - local older (stale)       → ACCEPT (take the cloud value; clears local)
 *   - IO gone on cloud          → TOMBSTONE (device removed; stop warning)
 *   - cloud-only                → informational (a normal pull brings it down)
 *   - conflict (same version,   → REVIEW (surface for a human)
 *     different value)
 *
 * "Cleared" normalizes to empty in both stores (a cleared result reads as no
 * result), matching the pull guard / battle harness `norm("Cleared") → None`.
 */

import type { LocalResultRow, CloudIoState } from '@/lib/cloud/result-reconciler'

export type SyncDiffClass =
  | 'in_sync'
  | 'local_only'        // local has a result; cloud has the IO but no result → push
  | 'local_newer'       // both have results, differ, local version wins → push
  | 'cloud_newer'       // both have results, differ, cloud version wins → local is stale
  | 'cloud_only'        // cloud has a result, local doesn't → a pull would bring it down
  | 'gone_on_cloud'     // local has a result but the IO is absent from cloud → removed device
  | 'conflict'          // differ, versions tie and timestamps can't break it → review

export type SyncDiffAction = 'push' | 'accept_cloud' | 'tombstone' | 'pull' | 'none'

export interface SyncDiffRow {
  id: number
  name: string
  classification: SyncDiffClass
  reason: string
  action: SyncDiffAction
  localResult: string | null
  localVersion: number
  localTimestamp: string | null
  cloudResult: string | null
  cloudVersion: number | null
}

export interface SyncDiffSummary {
  total: number
  inSync: number
  push: number         // local_only + local_newer
  acceptCloud: number  // cloud_newer
  tombstone: number    // gone_on_cloud
  pull: number         // cloud_only
  conflict: number
}

/** A cleared result reads as "no result" in both stores. */
export function normResult(v: string | null | undefined): string {
  if (v == null) return ''
  const t = String(v).trim()
  if (t === '' || t.toLowerCase() === 'cleared') return ''
  return t
}

function parseTs(v: string | null | undefined): number {
  if (!v) return NaN
  let s = String(v).trim()
  if (!s) return NaN
  if (!s.includes('T') && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s + 'Z'
  return Date.parse(s)
}

const REASON: Record<SyncDiffClass, string> = {
  in_sync: 'Local and cloud agree.',
  local_only: 'You have a result the cloud is missing — push it up.',
  local_newer: 'Your local result is newer than the cloud value — push it up (local wins).',
  cloud_newer: 'The cloud has a newer value than your local one — your local copy is stale. Accepting takes the cloud value.',
  cloud_only: 'The cloud has a result you don’t — a normal Pull would bring it down.',
  gone_on_cloud: 'This IO no longer exists on the cloud (device removed). It can never sync — accept it so it stops warning.',
  conflict: 'Local and cloud differ at the same version and timestamps can’t decide — needs a human.',
}

const ACTION_OF: Record<SyncDiffClass, SyncDiffAction> = {
  in_sync: 'none',
  local_only: 'push',
  local_newer: 'push',
  cloud_newer: 'accept_cloud',
  cloud_only: 'pull',
  gone_on_cloud: 'tombstone',
  conflict: 'none',
}

/**
 * Classify one IO. `local` is the Ios row (may be null if the IO only exists on
 * cloud); `cloud` is the cloud payload entry (undefined if the cloud lacks the
 * IO entirely). At least one must be present.
 */
export function classifyIo(
  id: number,
  name: string,
  local: LocalResultRow | null,
  cloud: CloudIoState | undefined,
): SyncDiffRow {
  const localResult = local ? local.Result ?? null : null
  const localVersion = local ? Number(local.Version) || 0 : 0
  const cloudResult = cloud ? (cloud.result ?? null) : null
  const cloudVersion = cloud ? Number(cloud.version) || 0 : null

  const lr = normResult(localResult)
  const cr = normResult(cloudResult)
  const localHas = lr !== ''
  const cloudHas = cr !== ''

  let cls: SyncDiffClass

  if (cloud === undefined) {
    // IO absent from the cloud payload entirely → removed device.
    cls = localHas ? 'gone_on_cloud' : 'in_sync'
  } else if (!localHas && !cloudHas) {
    cls = 'in_sync'
  } else if (localHas && !cloudHas) {
    cls = 'local_only'
  } else if (!localHas && cloudHas) {
    cls = 'cloud_only'
  } else if (lr === cr) {
    cls = 'in_sync'
  } else {
    // Both have DIFFERENT non-empty results → version decides, then timestamp.
    if (localVersion > (cloudVersion ?? 0)) cls = 'local_newer'
    else if ((cloudVersion ?? 0) > localVersion) cls = 'cloud_newer'
    else {
      const lt = parseTs(local?.Timestamp)
      const ct = parseTs(cloud?.result != null ? (cloud as { timestamp?: string }).timestamp : null)
      if (!Number.isNaN(lt) && !Number.isNaN(ct) && lt !== ct) {
        cls = lt > ct ? 'local_newer' : 'cloud_newer'
      } else {
        cls = 'conflict'
      }
    }
  }

  return {
    id,
    name,
    classification: cls,
    reason: REASON[cls],
    action: ACTION_OF[cls],
    localResult,
    localVersion,
    localTimestamp: local?.Timestamp ?? null,
    cloudResult,
    cloudVersion,
  }
}

/**
 * Diff every IO across local + cloud. `localRows` are Ios rows carrying a result
 * or comment; `localNames`/`cloudNames` provide display names by id. Only rows
 * that are NOT in_sync are returned (that's the actionable set); the summary
 * still counts everything.
 */
export function computeSyncDiff(
  localRows: readonly (LocalResultRow & { Name?: string | null })[],
  cloudIos: readonly (CloudIoState & { name?: string | null; timestamp?: string | null })[],
): { rows: SyncDiffRow[]; summary: SyncDiffSummary } {
  const localById = new Map<number, LocalResultRow & { Name?: string | null }>()
  for (const r of localRows) localById.set(Number(r.id), r)
  const cloudById = new Map<number, CloudIoState & { name?: string | null }>()
  for (const c of cloudIos) cloudById.set(Number(c.id), c)

  const ids = new Set<number>([...Array.from(localById.keys()), ...Array.from(cloudById.keys())])
  const rows: SyncDiffRow[] = []
  const summary: SyncDiffSummary = { total: 0, inSync: 0, push: 0, acceptCloud: 0, tombstone: 0, pull: 0, conflict: 0 }

  for (const id of Array.from(ids)) {
    const local = localById.get(id) ?? null
    const cloud = cloudById.get(id)
    const name =
      (local?.Name && String(local.Name)) ||
      (cloud?.name && String(cloud.name)) ||
      `IO #${id}`
    const row = classifyIo(id, name, local, cloud)
    summary.total++
    switch (row.classification) {
      case 'in_sync': summary.inSync++; break
      case 'local_only': case 'local_newer': summary.push++; break
      case 'cloud_newer': summary.acceptCloud++; break
      case 'gone_on_cloud': summary.tombstone++; break
      case 'cloud_only': summary.pull++; break
      case 'conflict': summary.conflict++; break
    }
    if (row.classification !== 'in_sync') rows.push(row)
  }

  // Most-actionable first: conflicts, then local pushes, stale accepts, gone, pull.
  const rank: Record<SyncDiffClass, number> = {
    conflict: 0, local_newer: 1, local_only: 2, cloud_newer: 3, gone_on_cloud: 4, cloud_only: 5, in_sync: 6,
  }
  rows.sort((a, b) => rank[a.classification] - rank[b.classification] || a.id - b.id)
  return { rows, summary }
}
