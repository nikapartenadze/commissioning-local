/**
 * AutoSync pull / catch-up paths (extracted from auto-sync.ts, behavior-neutral).
 *
 * Cloud→field reconciliation: the SSE-hint delta reaction, the multi-MCM
 * catch-up sweep, the legacy single-subsystem full pull, and the granular
 * L2 / VFD-addressed refreshers.
 *
 * These functions carry mutable run state (re-entrancy guards, throttle
 * timestamps, the last-pull status, and the in-memory IO version hash). That
 * state was previously private fields on AutoSyncService; it is now threaded in
 * via a `PullState` bag that the service owns and passes by reference, so every
 * read/write lands on the same per-instance object exactly as before. No logic,
 * SQL, ordering, timing, or error handling was changed.
 */

import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'
import { fetchAndApplyDelta } from '@/lib/cloud/delta-sync'
import { setSyncCursor } from '@/lib/cloud/sync-cursor'
import { pullVfdAddressed } from '@/lib/cloud/vfd-addressed-pull'
import { runConfigSidePulls } from '@/lib/cloud/config-side-pulls'
import { mcmTag } from '@/lib/logging/mcm-tag'
import { isActiveMcm } from '@/lib/cloud/active-mcms'
import { auditLog } from '@/lib/logging/recovery-log'

/**
 * Per-instance pull run state. Owned by AutoSyncService and passed by
 * reference so mutations here update the service's state, identical to the
 * former private fields.
 */
export interface PullState {
  isPulling: boolean
  isPullingMcms: boolean
  isSweeping: boolean
  lastPullVersion: string | null
  lastMcmCatchupAt: number
  lastManualPullAt: number
  lastVfdAddressedPullAt: number
  lastPullAt: Date | null
  lastPullResult: string | null
}

export function createPullState(): PullState {
  return {
    isPulling: false,
    isPullingMcms: false,
    isSweeping: false,
    lastPullVersion: null,
    lastMcmCatchupAt: 0,
    lastManualPullAt: 0,
    lastVfdAddressedPullAt: 0,
    lastPullAt: null,
    lastPullResult: null,
  }
}

/**
 * Pull the cloud-authoritative belt-tracking ADDRESSED flag for every
 * configured subsystem and mirror it into the local VfdAddressed table, so the
 * field VFD Commissioning page shows what a MECHANIC marked on the cloud.
 * Field is read-only here — marking happens cloud-side only. Throttled and
 * best-effort; never throws. Falls back to the single configured subsystem on
 * a field tablet (no MCM list).
 */
export async function pullVfdAddressedForConfigured(state: PullState, trigger: string): Promise<void> {
  const THROTTLE_MS = 30_000
  if (Date.now() - state.lastVfdAddressedPullAt < THROTTLE_MS) return
  state.lastVfdAddressedPullAt = Date.now()
  try {
    const cfg = await configService.getConfig()
    if (!cfg.remoteUrl) return

    // Resolve subsystem ids: configured MCM list (central) or the single
    // configured subsystem (field tablet).
    const ids = new Set<number>()
    try {
      const mcms = await configService.getMcms()
      for (const m of mcms) {
        if (m.enabled === false) continue
        const sid = parseInt(m.subsystemId, 10)
        if (Number.isFinite(sid) && sid > 0) ids.add(sid)
      }
    } catch { /* fall through to single-subsystem */ }
    if (ids.size === 0 && cfg.subsystemId) {
      const sid = typeof cfg.subsystemId === 'number' ? cfg.subsystemId : parseInt(String(cfg.subsystemId), 10)
      if (Number.isFinite(sid) && sid > 0) ids.add(sid)
    }
    if (ids.size === 0) return

    let total = 0
    for (const sid of Array.from(ids)) {
      total += await pullVfdAddressed(sid, { remoteUrl: cfg.remoteUrl, apiPassword: cfg.apiPassword })
    }
    if (total > 0) {
      console.log(`[AutoSync] ${trigger}: mirrored ${total} VFD ADDRESSED row(s) from cloud`)
    }
  } catch (e) {
    console.warn('[AutoSync] VFD addressed pull failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

/**
 * Delta-first reaction to a cloud `subsystem_changed` hint. The cloud
 * broadcasts every subsystem's hint to every authorized subscriber, so we
 * first confirm THIS tool manages the subsystem (a configured MCM, or the
 * single config.subsystemId on a field tablet) — otherwise a tablet would
 * pull a foreign project's IOs.
 *
 * Then it applies a GRANULAR, non-destructive delta (IO upserts + guarded
 * deletes) instead of the old destructive full pull. Falls back to the scoped
 * full pull only when needed: a `resync` verdict (fresh cursor / pruning gap),
 * a changed network/estop/safety section (no granular local section endpoint),
 * or a delta error. A changed L2 section uses the granular pull-l2 route.
 */
export async function pullSubsystemOnHint(state: PullState, subsystemId: number): Promise<void> {
  if (!Number.isFinite(subsystemId)) return
  if (Date.now() - state.lastManualPullAt < 30_000) return // a manual pull just ran

  // Is this subsystem one we manage?
  let managed = false
  try {
    const mcms = await configService.getMcms()
    managed = mcms.some((m) => m.enabled !== false && parseInt(m.subsystemId, 10) === subsystemId)
  } catch { /* fall through to single-subsystem check */ }
  if (!managed) {
    try {
      const cfg = await configService.getConfig()
      managed = parseInt(String(cfg.subsystemId), 10) === subsystemId
    } catch { /* no config yet */ }
  }
  if (!managed) {
    console.log(`[AutoSync] Ignoring subsystem_changed hint for unmanaged subsystem ${subsystemId}`)
    return
  }

  let cfg
  try { cfg = await configService.getConfig() } catch { return }
  if (!cfg.remoteUrl) return

  try {
    const result = await fetchAndApplyDelta(subsystemId, { remoteUrl: cfg.remoteUrl, apiPassword: cfg.apiPassword })

    if (result.resync) {
      // Empty resync (old cloud without snapshot support) → full-pull fallback.
      // Do NOT seed the cursor here: the full pull may be queue-gated, and
      // seeding past un-applied changes creates a propagation gap. An updated
      // cloud returns the snapshot inline (applyDelta applies it + advances the
      // cursor), so this branch is the backward-compat path only.
      console.log(`[AutoSync] delta resync for ${subsystemId} (no snapshot) → full pull`)
      await scopedFullPull(state, subsystemId)
      return
    }

    // Re-pull the config sections the delta flagged. vfd-addressed (ADDRESSED
    // handoff + VFD blocker) and L2 have granular local routes; network/estop/
    // safety and the rarer punchlist/change-request/roadmap have no granular
    // pull, so a scoped full pull refreshes them (gated; skips if local work
    // pending). guided_task is field-authored — nothing to pull back.
    const s = result.sections
    if (s.vfdBlocker) {
      await pullVfdAddressed(subsystemId, { remoteUrl: cfg.remoteUrl, apiPassword: cfg.apiPassword })
    }
    if (s.l2) {
      await pullL2Scoped(subsystemId, cfg.remoteUrl, cfg.apiPassword)
    }
    if (s.network || s.estop || s.safety || s.punchlist || s.changeRequest || s.roadmap) {
      await scopedFullPull(state, subsystemId)
    }

    state.lastPullAt = new Date()
    state.lastPullResult =
      `delta ${subsystemId}: +${result.applied}/-${result.deleted}` +
      (result.skippedDeletes.length ? ` (kept ${result.skippedDeletes.length} w/ local work)` : '')
    console.log(`[AutoSync] ${state.lastPullResult}`)
  } catch (e) {
    console.warn(`[AutoSync] delta for ${subsystemId} failed (${e instanceof Error ? e.message : 'fetch'}); falling back to full pull`)
    await scopedFullPull(state, subsystemId)
  }
}

/**
 * Periodic cloud→field DELTA SWEEP — safety net for a LOST SSE hint.
 *
 * The cloud writes a durable change-log row on every commit and broadcasts a
 * `subsystem_changed` hint, but if that hint never arrives (cloud crash between
 * commit and broadcast, a future 2nd cloud replica, a dropped SSE frame) nothing
 * on the field fetches the change until the next unrelated hint or SSE reconnect
 * — unbounded staleness. This timer periodically walks every MANAGED subsystem
 * and runs the SAME granular delta path the SSE hint uses
 * (`pullSubsystemOnHint` → `fetchAndApplyDelta`), so it reuses the cursor, the
 * non-destructive apply, the bulk-delete circuit breaker and the result-authority
 * guard already there — no second apply path. For a subsystem with nothing new
 * since its cursor the delta is a cheap no-op poll, so this adds negligible load
 * and never triggers a destructive/full pull on its own (only the granular delta
 * does, and only its own section-change/resync fallbacks — identical to a hint).
 *
 * Reentrant-safe: skips its own tick while a sweep or the multi-MCM catch-up is
 * already in flight. Coalescing with the hint path is implicit — a hint that just
 * advanced a subsystem's cursor makes this sweep's delta for it a no-op; and
 * `pullSubsystemOnHint` itself already yields for 30 s after a manual pull.
 */
export async function sweepConfiguredMcmsDelta(state: PullState, trigger: string): Promise<void> {
  if (state.isSweeping) return
  // A full multi-MCM catch-up (SSE reconnect / 15-min safety sweep) already
  // reconciles everything — don't double up.
  if (state.isPullingMcms) return

  // Resolve the subsystems this tool MANAGES: the configured MCM list on a
  // central server, or the single configured subsystem on a field tablet — the
  // same notion of "managed" the SSE-hint path and pullVfdAddressedForConfigured
  // use.
  const ids = new Set<number>()
  try {
    const mcms = await configService.getMcms()
    for (const m of mcms) {
      if (m.enabled === false) continue
      const sid = parseInt(m.subsystemId, 10)
      if (Number.isFinite(sid) && sid > 0) ids.add(sid)
    }
  } catch { /* fall through to single-subsystem */ }
  if (ids.size === 0) {
    try {
      const cfg = await configService.getConfig()
      const sid = typeof cfg.subsystemId === 'number' ? cfg.subsystemId : parseInt(String(cfg.subsystemId), 10)
      if (Number.isFinite(sid) && sid > 0) ids.add(sid)
    } catch { /* no config yet */ }
  }
  if (ids.size === 0) return

  state.isSweeping = true
  try {
    for (const sid of Array.from(ids)) {
      // Reuse the SSE-hint path verbatim — granular delta, non-destructive
      // apply, guarded deletes, result-authority. Sequential so a wide fleet
      // can't fan out a burst of concurrent fetches.
      await pullSubsystemOnHint(state, sid)
    }
    console.log(`${mcmTag(null)}[AutoSync] ${trigger}: delta swept ${ids.size} managed subsystem(s)`)
  } catch (e) {
    console.warn('[AutoSync] delta sweep failed (non-fatal):', e instanceof Error ? e.message : e)
  } finally {
    state.isSweeping = false
  }
}

/** Existing destructive scoped pull — now only a fallback (resync / section change / error). */
export async function scopedFullPull(state: PullState, subsystemId: number): Promise<void> {
  const port = process.env.PORT || '3000'
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/mcm/${encodeURIComponent(String(subsystemId))}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ background: true }),
      signal: AbortSignal.timeout(120_000),
    })
    if (r.status === 409) {
      console.log(`[AutoSync] scoped full pull for ${subsystemId} skipped (unsynced local work)`)
      return
    }
    const data = (await r.json().catch(() => ({}))) as { success?: boolean; iosCount?: number }
    state.lastPullAt = new Date()
    state.lastPullResult = `scoped pull ${subsystemId}: ${data?.success ? `ok(${data.iosCount ?? '?'})` : `err(${r.status})`}`
    console.log(`[AutoSync] ${state.lastPullResult}`)
  } catch (e) {
    console.warn(`[AutoSync] scoped full pull for ${subsystemId} failed: ${e instanceof Error ? e.message : 'fetch'}`)
  }
}

/** Granular L2/FV refresh (used when only the L2 section changed). */
export async function pullL2Scoped(subsystemId: number, remoteUrl: string, apiPassword?: string): Promise<void> {
  const port = process.env.PORT || '3000'
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/cloud/pull-l2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteUrl, apiPassword, subsystemId }),
      signal: AbortSignal.timeout(60_000),
    })
    if (r.status === 409) {
      // Pending-guard refusal: local FV work hasn't pushed yet, so the pull was
      // (correctly) refused. Used to be swallowed entirely — cloud→field FV then
      // went silently stale for as long as the queue stayed stuck (F5).
      const body = (await r.json().catch(() => ({}))) as { error?: string; pendingCount?: number }
      console.warn(`[AutoSync] pull-l2 for ${subsystemId} BLOCKED by pending-guard (409): ${body?.error ?? 'unsynced local L2 work'}`)
      auditLog({
        type: 'l2.pull.blocked',
        subsystemId,
        reason: body?.error ?? '409 pending-guard: unsynced local L2 work',
        detail: { pendingCount: body?.pendingCount ?? null, trigger: 'background-scoped' },
      })
      return
    }
    if (!r.ok) {
      console.warn(`[AutoSync] pull-l2 for ${subsystemId} returned HTTP ${r.status}`)
    }
  } catch (e) {
    console.warn(`[AutoSync] pull-l2 for ${subsystemId} failed: ${e instanceof Error ? e.message : 'fetch'}`)
  }
}

/**
 * Catch-up pull for EVERY configured MCM (central-server multi-MCM).
 *
 * The legacy pullFromCloud() reconciles only config.subsystemId; on a central
 * server running N MCMs the other N-1 would never reconcile events missed
 * during an SSE disconnect. This loops over the configured MCM list and reuses
 * POST /api/mcm/:id/pull, which REFUSES (409) to pull over unsynced local
 * changes — so it can never clobber a result that hasn't been pushed yet.
 *
 * Throttled to once per MIN_CATCHUP_GAP to avoid pull storms on flaky links.
 * Falls back to the legacy single-subsystem pull when no MCMs are configured
 * (field-tablet deployments are unchanged).
 */
export async function pullAllConfiguredMcms(state: PullState, trigger: string): Promise<void> {
  if (state.isPullingMcms) return
  const MIN_CATCHUP_GAP = 30_000
  if (Date.now() - state.lastMcmCatchupAt < MIN_CATCHUP_GAP) return
  if (Date.now() - state.lastManualPullAt < 30_000) return // a manual pull just ran

  let mcms: Array<{ subsystemId: string; enabled?: boolean; ip?: string }>
  try {
    mcms = await configService.getMcms()
  } catch {
    void pullFromCloud(state)
    return
  }

  // Only reconcile ACTIVE stations — those with an IP, i.e. connected/tested on
  // this server. Blank-IP stations aren't in use here and get freshened on
  // their first Connect (Connect All auto-pull), so re-pulling all 19 every
  // reconnect would be pure waste.
  const active = mcms.filter(isActiveMcm)
  if (active.length === 0) {
    void pullFromCloud(state) // legacy field-tablet mode / nothing active yet
    return
  }

  state.isPullingMcms = true
  state.lastMcmCatchupAt = Date.now()
  const port = process.env.PORT || '3000'
  console.log(`[AutoSync] ${trigger}: catch-up pull for ${active.length} active MCM(s)`)

  let cfg: Awaited<ReturnType<typeof configService.getConfig>> | null = null
  try { cfg = await configService.getConfig() } catch { cfg = null }

  // Gated full pull (destructive; refuses with 409 while local work is pending).
  const mcmFullPull = async (sid: number): Promise<string> => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/mcm/${sid}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ background: true }),
        signal: AbortSignal.timeout(120_000),
      })
      if (r.status === 409) return 'skip-pending'
      const data = (await r.json().catch(() => ({}))) as { success?: boolean; iosCount?: number }
      return data?.success ? `ok(${data.iosCount ?? '?'})` : `err(${r.status})`
    } catch (e) {
      return `err(${e instanceof Error ? e.message : 'fetch'})`
    }
  }

  try {
    const outcomes = await Promise.all(
      active.map(async (m) => {
        const sid = parseInt(m.subsystemId, 10)
        if (!Number.isFinite(sid)) return `${m.subsystemId}:bad-id`
        // Delta-first catch-up: the granular apply is NOT gated by the offline
        // queue, so cloud changes propagate even while local work is pending —
        // fixing the `skip-pending` stall the battle delta run exposed. Full
        // pull is only the fallback (resync / config-section change / error).
        if (!cfg || !cfg.remoteUrl) return `${sid}:${await mcmFullPull(sid)}`
        try {
          const result = await fetchAndApplyDelta(sid, { remoteUrl: cfg.remoteUrl, apiPassword: cfg.apiPassword })
          if (result.resync) {
            // Empty resync (old cloud, no snapshot) → full-pull fallback, no
            // cursor seed (gated pull + seed = propagation gap). Updated cloud
            // returns the snapshot inline (applyDelta applies it + seeds).
            return `${sid}:resync->${await mcmFullPull(sid)}`
          }
          const s = result.sections
          // ADDRESSED / VFD blocker has a granular route — refresh it without a
          // (gated, destructive) full pull.
          if (s.vfdBlocker) {
            try { await pullVfdAddressed(sid, { remoteUrl: cfg.remoteUrl, apiPassword: cfg.apiPassword }) } catch { /* best-effort */ }
          }
          if (s.network || s.estop || s.safety || s.punchlist || s.changeRequest || s.roadmap) {
            return `${sid}:delta(+${result.applied}/-${result.deleted})+sect->${await mcmFullPull(sid)}`
          }
          return `${sid}:delta(+${result.applied}/-${result.deleted})`
        } catch (e) {
          return `${sid}:delta-err->${await mcmFullPull(sid)}`
        }
      })
    )
    state.lastPullAt = new Date()
    state.lastPullResult = `mcm catch-up: ${outcomes.join(' ')}`
    console.log(`[AutoSync] catch-up done: ${outcomes.join(' ')}`)

    // Populate each active MCM's FV/L2 data ONCE (scoped per-MCM pull). The
    // per-MCM IO pull deliberately skips L2, so without this an MCM's FV page
    // stays empty on a central server until someone manually hits "Pull FV"
    // (the 2026-06-18 "FV shows only one MCM" report). Guarded to a one-time
    // pull per MCM — skip any MCM that already has scoped L2 devices — so it
    // never re-wipes or churns; ongoing cell edits arrive live via SSE, and a
    // manual Pull FV still forces a refresh.
    try {
      const remoteUrl = cfg?.remoteUrl
      const apiPassword = cfg?.apiPassword
      if (remoteUrl) {
        const countStmt = db.prepare('SELECT COUNT(*) as c FROM L2Devices WHERE SubsystemId = ?')
        for (const m of active) {
          const sid = parseInt(m.subsystemId, 10)
          if (!Number.isFinite(sid)) continue
          if ((countStmt.get(sid) as { c: number }).c > 0) continue
          try {
            await fetch(`http://127.0.0.1:${port}/api/cloud/pull-l2`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ remoteUrl, apiPassword, subsystemId: sid }),
              signal: AbortSignal.timeout(60_000),
            })
          } catch {
            /* best-effort per MCM — next catch-up retries */
          }
        }
      }
    } catch {
      /* best-effort L2 population */
    }
  } finally {
    state.isPullingMcms = false
  }
}

export async function pullFromCloud(state: PullState): Promise<void> {
  if (state.isPulling) return

  // Skip auto-pull if a manual pull just happened (within 30 seconds)
  // The manual pull already has the correct data — auto-pull would race with stale config
  if (Date.now() - state.lastManualPullAt < 30000) {
    state.lastPullResult = 'skipped (recent manual pull)'
    return
  }

  state.isPulling = true

  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    const subsystemId = config.subsystemId

    // Keep SSE client in sync with current config
    const sseClient = getCloudSseClient()
    if (sseClient && config.remoteUrl && config.subsystemId) {
      sseClient.updateConfig({
        remoteUrl: config.remoteUrl,
        apiPassword: config.apiPassword || '',
        subsystemId: config.subsystemId,
      })
    }

    if (!remoteUrl || !subsystemId) {
      state.lastPullResult = !remoteUrl ? 'no remote URL configured' : 'no subsystem configured'
      return
    }

    // Only ACTIVE (un-parked) rows gate the pull. Parked rows (DeadLettered=1)
    // are writes the cloud PERMANENTLY rejected — they will never sync, so
    // counting them here would block cloud→field propagation FOREVER: a tablet
    // with a single SPARE-Passed mistake (or any parked row) would stop pulling
    // coordinator/other-tablet changes indefinitely. The per-IO no-clobber set
    // below still preserves each parked IO's local value during the merge.
    const pendingIoCount = (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs WHERE DeadLettered = 0').get() as { count: number }).count
    const pendingL2Count = (db.prepare('SELECT COUNT(*) as count FROM L2PendingSyncs WHERE DeadLettered = 0').get() as { count: number }).count
    if (pendingIoCount > 0 || pendingL2Count > 0) {
      state.lastPullResult = `skipped (local pending syncs: io=${pendingIoCount}, l2=${pendingL2Count})`
      return
    }

    const cloudUrl = `${remoteUrl}/api/sync/subsystem/${subsystemId}`
    const response = await fetch(cloudUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiPassword || '',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      state.lastPullResult = `HTTP ${response.status}`
      return
    }

    const cloudData = await response.json()
    const cloudIos = Array.isArray(cloudData) ? cloudData : (cloudData.ios || cloudData.Ios || [])

    // Seed the delta cursor to the cloud's current max seq right after the
    // baseline pull, so subsequent cloud changes arrive as granular deltas.
    // Without this the cursor stays 0 and the delta path can't bootstrap —
    // the resync→full-pull that would otherwise seed it is gated by the
    // offline queue, which never drains under continuous field activity
    // (caught by the battle `delta` scenario). Forward-only; safe every pull.
    if (typeof cloudData?.cursorSeq === 'number' && cloudData.cursorSeq > 0) {
      try { setSyncCursor(parseInt(subsystemId, 10), cloudData.cursorSeq) } catch { /* cursor table optional */ }
    }

    if (cloudIos.length === 0) {
      state.lastPullAt = new Date()
      state.lastPullResult = 'no IOs from cloud'
      return
    }

    // Change detection — hash all versions to detect any change anywhere
    const versionHash = cloudIos.map((io: any) => `${io.id}:${io.version}:${io.result || '-'}`).join('|')
    if (versionHash === state.lastPullVersion) {
      // IO set unchanged — skip the IO merge, but STILL refresh the config/FV
      // sections. network/estop/safety/L2 changes on the cloud do NOT move the
      // IO version hash, so before this the legacy tablet path skipped them
      // here and they only reached the field after a service restart cleared
      // this in-memory hash. Mirrors the scoped /api/mcm/:id/pull no-op branch:
      // runConfigSidePulls is a scoped, idempotent per-section delete+reinsert,
      // and pullL2Scoped self-calls the FV pull — safe to run every cycle.
      try {
        const sid = parseInt(String(subsystemId), 10)
        if (Number.isFinite(sid)) {
          await runConfigSidePulls(sid, remoteUrl, apiPassword || '', { db })
          await pullL2Scoped(sid, remoteUrl, apiPassword)
        }
      } catch (e) {
        console.warn('[AutoSync] no-op config/FV side-pull failed:', e instanceof Error ? e.message : e)
      }
      state.lastPullAt = new Date()
      state.lastPullResult = 'no IO changes — refreshed config/FV'
      return
    }

    console.log(`[AutoSync] Pulling ${cloudIos.length} IO definitions from cloud...`)

    let updatedCount = 0
    let mergedResults = 0
    const subsystemIdNum = parseInt(subsystemId, 10)
    const pendingIoIds = new Set(
      (db.prepare('SELECT DISTINCT IoId FROM PendingSyncs').all() as Array<{ IoId: number }>).map(row => row.IoId)
    )

    const selectStmt = db.prepare('SELECT Result, Version FROM Ios WHERE id = ?')
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO Ios (id, SubsystemId, Name, Description, "Order", Version, TagType, Result, Timestamp, Comments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const updateDefStmt = db.prepare(`
      UPDATE Ios SET Name = ?, Description = ?, "Order" = ?, Version = ?, TagType = COALESCE(?, TagType)
      WHERE id = ?
    `)
    const updateWithResultStmt = db.prepare(`
      UPDATE Ios SET Name = ?, Description = ?, "Order" = ?, Version = ?, TagType = COALESCE(?, TagType),
      Result = ?, Timestamp = ?, Comments = ?
      WHERE id = ?
    `)

    const pullTransaction = db.transaction(() => {
      // Auto-pull must never switch subsystems behind the user's back.
      const existingSubIds = db.prepare('SELECT DISTINCT SubsystemId FROM Ios').all() as { SubsystemId: number }[]
      const hasOtherSubsystems = existingSubIds.some(s => s.SubsystemId !== subsystemIdNum)
      if (hasOtherSubsystems) {
        throw new Error(`auto-pull refused subsystem switch from ${existingSubIds.map(s => s.SubsystemId).join(',')} to ${subsystemIdNum}`)
      }

      for (const cloudIo of cloudIos) {
        if (!cloudIo.name || cloudIo.id <= 0) continue

        try {
          const localIo = selectStmt.get(cloudIo.id) as { Result: string | null, Version: number } | undefined

          const cloudVersion = Number(cloudIo.version) || 0
          const localVersion = localIo?.Version ?? 0
          const hasLocalPendingSync = pendingIoIds.has(cloudIo.id)

          // Never overwrite local dirty state. Only merge cloud results/comments when cloud is newer
          // and this IO has no unsynced local writes waiting in PendingSyncs.
          const shouldMergeResult =
            cloudIo.result !== undefined &&
            !hasLocalPendingSync &&
            cloudVersion > localVersion

          if (!localIo) {
            // Insert new IO
            insertStmt.run(
              cloudIo.id,
              subsystemIdNum,
              cloudIo.name,
              cloudIo.description ?? null,
              cloudIo.order ?? null,
              cloudVersion,
              cloudIo.tagType ?? null,
              cloudIo.result ?? null,
              cloudIo.timestamp ?? null,
              cloudIo.comments ?? null,
            )
          } else if (shouldMergeResult) {
            updateWithResultStmt.run(
              cloudIo.name,
              cloudIo.description ?? null,
              cloudIo.order ?? null,
              cloudVersion,
              cloudIo.tagType ?? null,
              cloudIo.result || null,
              cloudIo.timestamp ?? null,
              cloudIo.comments ?? null,
              cloudIo.id,
            )
            mergedResults++
          } else {
            updateDefStmt.run(
              cloudIo.name,
              cloudIo.description ?? null,
              cloudIo.order ?? null,
              cloudVersion,
              cloudIo.tagType ?? null,
              cloudIo.id,
            )
          }
          updatedCount++
        } catch {
          // Skip individual IO errors
        }
      }
    })

    pullTransaction()

    state.lastPullVersion = versionHash
    state.lastPullAt = new Date()
    state.lastPullResult = `updated ${updatedCount} IOs${mergedResults > 0 ? `, merged ${mergedResults} results from other users` : ''}`

    if (updatedCount > 0) {
      console.log(`[AutoSync] Updated ${updatedCount} IOs from cloud${mergedResults > 0 ? ` (merged ${mergedResults} test results from other users)` : ''}`)

      // Broadcast to all connected browsers
      try {
        const broadcastUrl = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast'
        await fetch(broadcastUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'IOsUpdated', count: updatedCount, source: 'auto-sync' }),
        })
      } catch { /* WS server might not be running */ }
    }

    // Pull back change request status updates from cloud
    try {
      const syncedRequests = db.prepare(
        "SELECT * FROM ChangeRequests WHERE CloudId IS NOT NULL AND Status = 'synced' LIMIT 100"
      ).all() as any[]

      if (syncedRequests.length > 0 && remoteUrl) {
        const cloudIds = syncedRequests.map(r => r.CloudId).filter(Boolean)
        const crResp = await fetch(`${remoteUrl}/api/sync/change-requests/status?ids=${cloudIds.join(',')}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
          signal: AbortSignal.timeout(10000),
        })
        if (crResp.ok) {
          const crData = await crResp.json()
          if (Array.isArray(crData.requests)) {
            const updateCrStatusStmt = db.prepare(
              'UPDATE ChangeRequests SET Status = ?, ReviewedBy = ?, ReviewNote = ?, UpdatedAt = ? WHERE CloudId = ?'
            )
            for (const cr of crData.requests) {
              if (cr.cloudId && cr.status && cr.status !== 'synced') {
                try {
                  updateCrStatusStmt.run(
                    cr.status,
                    cr.reviewedBy || null,
                    cr.reviewNote || null,
                    new Date().toISOString(),
                    cr.cloudId,
                  )
                } catch (e) { console.warn('[AutoSync] Failed to update CR status:', e) }
              }
            }
            console.log(`[AutoSync] Pulled ${crData.requests.length} change request status updates`)
          }
        }
      }
    } catch (err) {
      console.warn('[AutoSync] Change request pull error:', err instanceof Error ? err.message : err)
    }

    try {
      const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
      getCloudSyncService().setConnectionState('connected')
    } catch (err) {
      console.warn('[AutoSync] Failed to set cloud connection state:', err)
    }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    state.lastPullResult = `error: ${msg}`
    if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED')) {
      console.warn(`[AutoSync] Pull error: ${msg}`)
    }
  } finally {
    state.isPulling = false
  }
}
